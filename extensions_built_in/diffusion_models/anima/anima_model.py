"""Anima 2B (Circlestone Labs) model integration.

Anima is a Cosmos-Predict2 "MiniTrainDIT" rectified-flow DiT paired with a
frozen Qwen3-0.6B text encoder, a 6-layer LLM adapter (bridges Qwen3 hidden
states into a T5-token-indexed cross-attention space) and the Qwen-Image
(Wan 2.1) VAE. Reference implementations: kohya sd-scripts (v0.10.5+,
``anima_train_network.py``) and tdrussell's diffusion-pipe — see
docs/anima_delta_catalog.md for the full parity notes.

Conditioning is unusual: every caption is tokenized twice. The Qwen3 tokens
run through the text encoder to produce hidden states; the T5 tokens are never
encoded by any T5 model — they are embedded by the adapter (inside the DiT
forward) which cross-attends into the Qwen3 states.
"""

import os
from typing import List, Optional

import huggingface_hub
import torch
import yaml
from safetensors.torch import load_file, save_file

from diffusers import AutoencoderKLQwenImage
from transformers import AutoModelForCausalLM, AutoTokenizer, T5TokenizerFast
from optimum.quanto import freeze

from toolkit.accelerator import unwrap_model
from toolkit.advanced_prompt_embeds import AdvancedPromptEmbeds
from toolkit.basic import flush
from toolkit.config_modules import GenerateImageConfig, ModelConfig
from toolkit.models.base_model import BaseModel
from toolkit.samplers.custom_flowmatch_sampler import (
    CustomFlowMatchEulerDiscreteScheduler,
)
from toolkit.util.quantize import quantize, get_qtype, quantize_model

from .src.anima_transformer import (
    AnimaTransformer2DModel,
    detect_anima_config,
    strip_net_prefix,
)
from .src.pipeline import AnimaPipeline

ANIMA_HF_REPO = "circlestone-labs/Anima"
ANIMA_HF_SUBDIR = "split_files/diffusion_models"
ANIMA_DEFAULT_FILE = "anima-base-v1.0.safetensors"
QWEN3_HF_REPO = "Qwen/Qwen3-0.6B-Base"
QWEN_IMAGE_VAE_REPO = "Qwen/Qwen-Image"
T5_TOKENIZER_REPO = "google/t5-v1_1-xxl"

# inference flow shift 3.0 is Anima's sampling default (sd-scripts
# anima_train_utils.do_sample). Training with timestep_type "sigmoid"
# (the default) never consults shift.
scheduler_config = {
    "num_train_timesteps": 1000,
    "use_dynamic_shifting": False,
    "shift": 3.0,
}

# both tokenizers pad/truncate to a fixed 512 (sd-scripts AnimaTokenizeStrategy)
MAX_TOKEN_LENGTH = 512


class AnimaFlowMatchScheduler(CustomFlowMatchEulerDiscreteScheduler):
    """Adds Anima's ``sigmoid_scale`` to the sigmoid timestep sampler.

    sd-scripts samples sigma = sigmoid(sigmoid_scale * randn()); the stock
    toolkit sampler is the scale=1.0 case. Values > 1 widen the logit-normal,
    weighting the extreme timesteps more (the Anima author trains with 1.3).
    """

    sigmoid_scale: float = 1.0

    def set_train_timesteps(self, num_timesteps, device, timestep_type="linear", latents=None, patch_size=1):
        if timestep_type == "sigmoid" and self.sigmoid_scale != 1.0:
            self.timestep_type = timestep_type
            t = torch.sigmoid(self.sigmoid_scale * torch.randn((num_timesteps,), device=device))
            timesteps = (1 - t) * 1000
            timesteps, _ = torch.sort(timesteps, descending=True)
            self.timesteps = timesteps.to(device=device)
            return timesteps
        return super().set_train_timesteps(
            num_timesteps, device, timestep_type=timestep_type, latents=latents, patch_size=patch_size
        )


class AnimaModel(BaseModel):
    arch = "anima"
    use_old_lokr_format = False

    _anima_sigmoid_scale = 1.0

    def __init__(self, device, model_config: ModelConfig, dtype="bf16", custom_pipeline=None, noise_scheduler=None, **kwargs):
        super().__init__(device, model_config, dtype, custom_pipeline, noise_scheduler, **kwargs)
        self.is_flow_matching = True
        self.is_transformer = True
        # LoRA attaches to Linear children of the DiT blocks only — mirrors
        # sd-scripts' default targeting (its PatchEmbed/TimestepEmbedding/
        # FinalLayer nominal targets are fully excluded by its default
        # ``.*(_modulation|_norm|_embedder|final_layer).*`` regex anyway, and
        # the LLM adapter must stay frozen per the model author). To also match
        # sd-scripts' exclusion of the AdaLN modulation linears, configs should
        # set network.network_kwargs.ignore_if_contains: ["adaln_modulation"].
        self.target_lora_modules = ["Block"]

        self.patch_size = 2
        self.vae_scale_factor = 8

        model_kwargs = getattr(self.model_config, "model_kwargs", None) or {}
        AnimaModel._anima_sigmoid_scale = float(model_kwargs.get("sigmoid_scale", 1.0))

        # set by load_model
        self.t5_tokenizer = None

    @staticmethod
    def get_train_scheduler():
        scheduler = AnimaFlowMatchScheduler(**scheduler_config)
        scheduler.sigmoid_scale = AnimaModel._anima_sigmoid_scale
        return scheduler

    def get_bucket_divisibility(self):
        # VAE 8x downscale * DiT patch size 2
        return self.vae_scale_factor * self.patch_size

    def get_quantization_exclude_modules(self) -> Optional[List[str]]:
        # mirror sd-scripts' FP8 exclusions: embedders, norms, AdaLN
        # modulations, the final layer and the whole LLM adapter stay in
        # full precision
        return [
            "x_embedder*",
            "t_embedder*",
            "t_embedding_norm*",
            "pos_embedder*",
            "*_norm*",
            "*layer_norm*",
            "*adaln_modulation*",
            "final_layer*",
            "llm_adapter*",
        ]

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------
    def _resolve_dit_path(self) -> str:
        model_path = self.model_config.name_or_path
        if os.path.exists(model_path):
            return model_path
        if model_path == ANIMA_HF_REPO:
            return huggingface_hub.hf_hub_download(
                repo_id=ANIMA_HF_REPO,
                filename=f"{ANIMA_HF_SUBDIR}/{ANIMA_DEFAULT_FILE}",
            )
        if model_path.startswith(f"{ANIMA_HF_REPO}/"):
            filename = model_path[len(ANIMA_HF_REPO) + 1:]
            if not filename.startswith(ANIMA_HF_SUBDIR):
                filename = f"{ANIMA_HF_SUBDIR}/{filename}"
            return huggingface_hub.hf_hub_download(repo_id=ANIMA_HF_REPO, filename=filename)
        raise ValueError(
            f"Anima model path '{model_path}' does not exist. Use a local "
            f".safetensors path, '{ANIMA_HF_REPO}' (downloads {ANIMA_DEFAULT_FILE}) "
            f"or '{ANIMA_HF_REPO}/<checkpoint>.safetensors'."
        )

    def load_model(self):
        dtype = self.torch_dtype
        self.print_and_status_update("Loading Anima model")

        # --- DiT (single safetensors, ComfyUI "net." prefixed) ---
        dit_path = self._resolve_dit_path()
        self.print_and_status_update("Loading transformer")
        state_dict = load_file(dit_path, "cpu")
        state_dict = strip_net_prefix(state_dict)
        config = detect_anima_config(state_dict)
        with torch.device("meta"):
            transformer = AnimaTransformer2DModel(**config)
        state_dict = {k: v.to(dtype) for k, v in state_dict.items()}
        load_result = transformer.load_state_dict(state_dict, strict=False, assign=True)
        # RoPE tables and the adapter's inv_freq are computed, not stored
        allowed_missing = ("seq", "dim_spatial_range", "dim_temporal_range", "inv_freq")
        missing = [k for k in load_result.missing_keys if not k.endswith(allowed_missing)]
        if missing or load_result.unexpected_keys:
            raise RuntimeError(
                f"Anima DiT load mismatch. missing={missing} unexpected={load_result.unexpected_keys}"
            )
        # materialize the buffers that were skipped by assign=True loading
        transformer.rebuild_buffers()
        del state_dict
        flush()

        if self.model_config.quantize:
            self.print_and_status_update("Quantizing transformer")
            quantize_model(self, transformer)
            flush()

        if self.model_config.low_vram:
            transformer.to("cpu")
        else:
            transformer.to(self.device_torch, dtype=dtype)
        flush()

        # --- Qwen3-0.6B text encoder (backbone only, always frozen) ---
        self.print_and_status_update("Loading Qwen3 text encoder")
        te_path = self.model_config.te_name_or_path or QWEN3_HF_REPO
        qwen3_tokenizer = AutoTokenizer.from_pretrained(te_path)
        if qwen3_tokenizer.pad_token is None:
            qwen3_tokenizer.pad_token = qwen3_tokenizer.eos_token
        text_encoder = AutoModelForCausalLM.from_pretrained(te_path, torch_dtype=dtype).model
        text_encoder.config.use_cache = False
        text_encoder.to(self.te_device_torch)
        text_encoder.eval()
        text_encoder.requires_grad_(False)
        flush()

        if self.model_config.quantize_te:
            self.print_and_status_update("Quantizing text encoder")
            quantize(text_encoder, weights=get_qtype(self.model_config.qtype_te))
            freeze(text_encoder)
            flush()

        # --- T5 tokenizer (token ids only; no T5 model is ever loaded) ---
        self.t5_tokenizer = T5TokenizerFast.from_pretrained(T5_TOKENIZER_REPO)

        # --- Qwen-Image VAE (identical weights to Anima's distributed VAE) ---
        self.print_and_status_update("Loading VAE")
        vae_path = self.model_config.vae_path or QWEN_IMAGE_VAE_REPO
        if os.path.isdir(vae_path) and not os.path.exists(os.path.join(vae_path, "config.json")):
            vae = AutoencoderKLQwenImage.from_pretrained(vae_path, subfolder="vae", torch_dtype=dtype)
        elif os.path.isdir(vae_path):
            vae = AutoencoderKLQwenImage.from_pretrained(vae_path, torch_dtype=dtype)
        else:
            vae = AutoencoderKLQwenImage.from_pretrained(vae_path, subfolder="vae", torch_dtype=dtype)
        vae.to(self.vae_device_torch, dtype=self.vae_torch_dtype)
        vae.eval()
        vae.requires_grad_(False)
        flush()

        self.noise_scheduler = AnimaModel.get_train_scheduler()
        self.vae = vae
        self.text_encoder = [text_encoder]
        self.tokenizer = [qwen3_tokenizer]
        self.model = transformer
        self.pipeline = AnimaPipeline(self)
        self.print_and_status_update("Model Loaded")

    # ------------------------------------------------------------------
    # Prompt encoding
    # ------------------------------------------------------------------
    def get_prompt_embeds(self, prompt) -> AdvancedPromptEmbeds:
        if isinstance(prompt, str):
            prompt = [prompt]

        text_encoder = self.text_encoder[0]
        tokenizer = self.tokenizer[0]
        if text_encoder.device == torch.device("cpu"):
            text_encoder.to(self.device_torch)

        text_embeds = []
        qwen3_attn_masks = []
        t5_input_ids = []
        t5_attn_masks = []
        for p in prompt:
            qwen3_enc = tokenizer(
                p,
                return_tensors="pt",
                truncation=True,
                padding="max_length",
                max_length=MAX_TOKEN_LENGTH,
            ).to(text_encoder.device)
            t5_enc = self.t5_tokenizer(
                p,
                return_tensors="pt",
                truncation=True,
                padding="max_length",
                max_length=MAX_TOKEN_LENGTH,
            )
            with torch.no_grad():
                output = text_encoder(
                    input_ids=qwen3_enc.input_ids,
                    attention_mask=qwen3_enc.attention_mask,
                )
            embeds = output.last_hidden_state
            # sd-scripts hard-zeroes the hidden states at padded positions
            embeds = embeds.clone()
            embeds[~qwen3_enc.attention_mask.bool()] = 0

            text_embeds.append(embeds[0].to(self.torch_dtype))          # (512, 1024)
            qwen3_attn_masks.append(qwen3_enc.attention_mask[0].cpu())  # (512,)
            t5_input_ids.append(t5_enc.input_ids[0])                    # (512,)
            t5_attn_masks.append(t5_enc.attention_mask[0])              # (512,)

        pe = AdvancedPromptEmbeds(
            text_embeds=text_embeds,
            qwen3_attn_mask=qwen3_attn_masks,
            t5_input_ids=t5_input_ids,
            t5_attn_mask=t5_attn_masks,
        )
        pe.frozen_dtype_keys = ["qwen3_attn_mask", "t5_input_ids", "t5_attn_mask"]
        return pe

    # ------------------------------------------------------------------
    # Training forward
    # ------------------------------------------------------------------
    def get_noise_prediction(
        self,
        latent_model_input: torch.Tensor,
        timestep: torch.Tensor,
        text_embeddings: AdvancedPromptEmbeds,
        **kwargs,
    ):
        if self.model.device == torch.device("cpu"):
            self.model.to(self.device_torch)
        device = self.device_torch
        dtype = self.torch_dtype

        # toolkit timestep 0..1000 (1000 = pure noise) -> Anima t in [0, 1]
        t01 = timestep.to(device, dtype=torch.float32) / 1000.0

        context = torch.stack(
            [e.to(device, dtype) for e in text_embeddings.text_embeds], dim=0
        )
        source_attention_mask = torch.stack(
            [m.to(device) for m in text_embeddings.qwen3_attn_mask], dim=0
        )
        target_input_ids = torch.stack(
            [i.to(device) for i in text_embeddings.t5_input_ids], dim=0
        )
        target_attention_mask = torch.stack(
            [m.to(device) for m in text_embeddings.t5_attn_mask], dim=0
        )

        latents_5d = latent_model_input.to(device, dtype).unsqueeze(2)  # (B, C, 1, h, w)
        padding_mask = torch.zeros(
            (latents_5d.shape[0], 1, latents_5d.shape[3], latents_5d.shape[4]),
            device=device,
            dtype=dtype,
        )

        noise_pred = self.model(
            latents_5d,
            timesteps=t01,
            context=context,
            padding_mask=padding_mask,
            target_input_ids=target_input_ids,
            target_attention_mask=target_attention_mask,
            source_attention_mask=source_attention_mask,
        )
        return noise_pred.squeeze(2)

    def get_loss_target(self, *args, **kwargs):
        noise = kwargs.get("noise")
        batch = kwargs.get("batch")
        # rectified flow velocity: v = noise - clean
        return (noise - batch.latents).detach()

    # ------------------------------------------------------------------
    # Sampling
    # ------------------------------------------------------------------
    def get_generation_pipeline(self):
        return AnimaPipeline(self)

    def generate_single_image(
        self,
        pipeline: AnimaPipeline,
        gen_config: GenerateImageConfig,
        conditional_embeds: AdvancedPromptEmbeds,
        unconditional_embeds: AdvancedPromptEmbeds,
        generator: torch.Generator,
        extra: dict,
    ):
        if self.model.device == torch.device("cpu"):
            self.model.to(self.device_torch)
        sc = self.get_bucket_divisibility()
        gen_config.width = int(gen_config.width // sc * sc)
        gen_config.height = int(gen_config.height // sc * sc)

        img = pipeline(
            conditional_embeds=conditional_embeds,
            unconditional_embeds=unconditional_embeds,
            height=gen_config.height,
            width=gen_config.width,
            num_inference_steps=gen_config.num_inference_steps,
            guidance_scale=gen_config.guidance_scale,
            latents=gen_config.latents,
            generator=generator,
        )[0]
        return img

    # ------------------------------------------------------------------
    # VAE encode / decode (Qwen-Image video VAE, per-channel normalization,
    # deterministic mode() to match sd-scripts/diffusion-pipe exactly)
    # ------------------------------------------------------------------
    def encode_images(self, image_list: List[torch.Tensor], device=None, dtype=None):
        if device is None:
            device = self.vae_device_torch
        if dtype is None:
            dtype = self.vae_torch_dtype
        if self.vae.device == torch.device("cpu"):
            self.vae.to(device)
        self.vae.eval()
        self.vae.requires_grad_(False)

        if isinstance(image_list, list):
            images = torch.stack([img.to(device, dtype=dtype) for img in image_list])
        else:
            images = image_list.to(device, dtype=dtype)
        images = images.unsqueeze(2)  # frame dim for the video VAE

        # NOTE: both reference trainers use the deterministic mode(), not
        # sample() — keep it that way for parity
        latents = self.vae.encode(images).latent_dist.mode()

        latents_mean = (
            torch.tensor(self.vae.config.latents_mean)
            .view(1, self.vae.config.z_dim, 1, 1, 1)
            .to(latents.device, latents.dtype)
        )
        latents_std_inv = 1.0 / torch.tensor(self.vae.config.latents_std).view(
            1, self.vae.config.z_dim, 1, 1, 1
        ).to(latents.device, latents.dtype)

        latents = (latents - latents_mean) * latents_std_inv
        return latents.squeeze(2).to(device, dtype=dtype)

    def decode_latents(self, latents: torch.Tensor, device=None, dtype=None):
        if device is None:
            device = self.vae_device_torch
        if dtype is None:
            dtype = self.vae_torch_dtype
        if self.vae.device == torch.device("cpu"):
            self.vae.to(device)

        latents = latents.to(device, dtype=dtype).unsqueeze(2)
        latents_mean = (
            torch.tensor(self.vae.config.latents_mean)
            .view(1, self.vae.config.z_dim, 1, 1, 1)
            .to(latents.device, latents.dtype)
        )
        latents_std = torch.tensor(self.vae.config.latents_std).view(
            1, self.vae.config.z_dim, 1, 1, 1
        ).to(latents.device, latents.dtype)
        latents = latents * latents_std + latents_mean

        images = self.vae.decode(latents).sample
        return images.squeeze(2).to(device, dtype=dtype)

    # ------------------------------------------------------------------
    # Saving / bookkeeping
    # ------------------------------------------------------------------
    def get_model_has_grad(self):
        return next(unwrap_model(self.model).parameters()).requires_grad

    def get_te_has_grad(self):
        return False

    def save_model(self, output_path, meta, save_dtype):
        transformer = unwrap_model(self.model)
        os.makedirs(output_path, exist_ok=True)
        # ComfyUI checkpoint format: "net." prefix, format=pt metadata
        state_dict = {
            "net." + k: v.clone().to("cpu", dtype=save_dtype).contiguous()
            for k, v in transformer.state_dict().items()
        }
        save_file(
            state_dict,
            os.path.join(output_path, "anima.safetensors"),
            metadata={"format": "pt"},
        )
        with open(os.path.join(output_path, "aitk_meta.yaml"), "w") as f:
            yaml.dump(meta, f)

    def get_base_model_version(self):
        return "anima_2b"

    def get_transformer_block_names(self) -> Optional[List[str]]:
        return ["blocks"]

    # ------------------------------------------------------------------
    # LoRA key conversion: toolkit PEFT keys <-> kohya sd-scripts keys
    #
    # ComfyUI/SwarmUI load Anima DiT LoRAs in sd-scripts format directly,
    # and the user's existing TrainFlow-trained LoRAs use it, so exports
    # must match it byte-for-byte (spec gate A3):
    #   transformer.blocks.0.self_attn.q_proj.lora_A.weight
    #     -> lora_unet_blocks_0_self_attn_q_proj.lora_down.weight
    # plus a per-module scalar ``alpha`` tensor. The toolkit trains PEFT
    # LoRAs with an implicit alpha == rank (scale 1.0), so alpha is
    # synthesized as the rank on save.
    # ------------------------------------------------------------------
    def convert_lora_weights_before_save(self, state_dict):
        new_sd = {}
        module_ranks = {}
        for key, value in state_dict.items():
            if key.startswith("transformer.") and ".lora_A.weight" in key:
                module_path = key[len("transformer."):].replace(".lora_A.weight", "")
                module_ranks[module_path] = value.shape[0]

        for key, value in state_dict.items():
            if not key.startswith("transformer."):
                new_sd[key] = value
                continue
            module_path = key[len("transformer."):]
            if module_path.endswith(".lora_A.weight"):
                module_path = module_path[: -len(".lora_A.weight")]
                suffix = "lora_down.weight"
            elif module_path.endswith(".lora_B.weight"):
                module_path = module_path[: -len(".lora_B.weight")]
                suffix = "lora_up.weight"
            else:
                new_sd[key] = value
                continue
            lora_name = "lora_unet_" + module_path.replace(".", "_")
            new_sd[f"{lora_name}.{suffix}"] = value
            alpha_key = f"{lora_name}.alpha"
            if alpha_key not in new_sd and module_path in module_ranks:
                new_sd[alpha_key] = torch.tensor(
                    float(module_ranks[module_path]), dtype=value.dtype
                )
        return new_sd

    def convert_lora_weights_before_load(self, state_dict):
        # already in toolkit format? (e.g. resuming a toolkit-saved ckpt from
        # before this converter existed)
        if any(k.startswith("transformer.") for k in state_dict.keys()):
            return state_dict

        # rebuild the dotted module paths from the model itself so the
        # underscore -> dot conversion is unambiguous
        underscored_to_dotted = {}
        for name, _ in unwrap_model(self.model).named_modules():
            if name:
                underscored_to_dotted[name.replace(".", "_")] = name

        alphas = {}
        weights = {}
        for key, value in state_dict.items():
            if not key.startswith("lora_unet_"):
                weights[key] = value  # pass through anything foreign
                continue
            rest = key[len("lora_unet_"):]
            module_part, _, suffix = rest.partition(".")
            if suffix == "alpha":
                alphas[module_part] = value
                continue
            dotted = underscored_to_dotted.get(module_part)
            if dotted is None:
                raise ValueError(
                    f"Cannot map LoRA key '{key}' onto the Anima transformer "
                    f"(no module '{module_part}')"
                )
            if suffix == "lora_down.weight":
                weights[(module_part, "A")] = (f"transformer.{dotted}.lora_A.weight", value)
            elif suffix == "lora_up.weight":
                weights[(module_part, "B")] = (f"transformer.{dotted}.lora_B.weight", value)
            else:
                weights[f"transformer.{dotted}.{suffix}"] = value

        new_sd = {}
        for key, value in weights.items():
            if isinstance(key, tuple):
                module_part, ab = key
                new_key, tensor = value
                # toolkit LoRA runs at scale 1.0 (alpha == rank); fold any
                # differing sd-scripts alpha/rank scale into lora_up
                if ab == "B" and module_part in alphas:
                    rank = tensor.shape[1]
                    alpha = float(alphas[module_part])
                    if alpha != rank and rank > 0:
                        tensor = tensor * (alpha / rank)
                new_sd[new_key] = tensor
            else:
                new_sd[key] = value
        return new_sd
