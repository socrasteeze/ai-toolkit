"""Euler rectified-flow sampler for Anima training previews.

Matches sd-scripts' ``anima_train_utils.do_sample``: Euler integration over a
shifted linspace(1, 0) sigma schedule (shift applied by the diffusers
FlowMatchEulerDiscreteScheduler with shift=3.0 from the model's
scheduler_config), CFG as ``uncond + scale * (cond - uncond)``.

Prompts arrive pre-encoded (AdvancedPromptEmbeds with keys text_embeds /
qwen3_attn_mask / t5_input_ids / t5_attn_mask, one fixed-length-512 tensor per
prompt) — ai-toolkit encodes them itself so it can cache and apply triggers.
"""

from typing import List, Optional

import torch
from PIL import Image
from diffusers.utils.torch_utils import randn_tensor


def stack_embeds(embeds, device, dtype):
    """Anima conditioning tensors are fixed-length (512) — plain stack."""
    context = torch.stack([e.to(device, dtype) for e in embeds.text_embeds], dim=0)
    source_mask = torch.stack([m.to(device) for m in embeds.qwen3_attn_mask], dim=0)
    t5_ids = torch.stack([i.to(device) for i in embeds.t5_input_ids], dim=0)
    t5_mask = torch.stack([m.to(device) for m in embeds.t5_attn_mask], dim=0)
    return context, source_mask, t5_ids, t5_mask


class AnimaPipeline:
    def __init__(self, model):
        self.model = model

    @property
    def device(self):
        return self.model.device_torch

    def to(self, *args, **kwargs):
        return self

    def set_progress_bar_config(self, **kwargs):
        pass

    @torch.no_grad()
    def __call__(
        self,
        conditional_embeds,
        unconditional_embeds,
        height: int = 1024,
        width: int = 1024,
        num_inference_steps: int = 30,
        guidance_scale: float = 7.5,
        latents: Optional[torch.Tensor] = None,
        generator: Optional[torch.Generator] = None,
        **kwargs,
    ) -> List[Image.Image]:
        model = self.model
        device = model.device_torch
        dtype = model.torch_dtype
        transformer = model.transformer

        scheduler = model.get_train_scheduler()
        scheduler.set_timesteps(num_inference_steps, device=device)
        timesteps = scheduler.timesteps  # 1000 -> 0, shift already applied

        gh = height // model.vae_scale_factor
        gw = width // model.vae_scale_factor

        do_cfg = unconditional_embeds is not None and guidance_scale > 1.0

        if latents is None:
            shape = (1, transformer.in_channels, gh, gw)
            latents = randn_tensor(shape, generator=generator, device=device, dtype=torch.float32)
        latents = latents.to(device, dtype=torch.float32)

        cond = stack_embeds(conditional_embeds, device, dtype)
        if do_cfg:
            uncond = stack_embeds(unconditional_embeds, device, dtype)

        for t in timesteps:
            t01 = (t / 1000.0).to(device, dtype=torch.float32).expand(latents.shape[0])
            latents_5d = latents.to(dtype).unsqueeze(2)
            padding_mask = torch.zeros(
                (latents_5d.shape[0], 1, latents_5d.shape[3], latents_5d.shape[4]),
                device=device,
                dtype=dtype,
            )

            def predict(embeds):
                context, source_mask, t5_ids, t5_mask = embeds
                return transformer(
                    latents_5d,
                    timesteps=t01,
                    context=context,
                    padding_mask=padding_mask,
                    target_input_ids=t5_ids,
                    target_attention_mask=t5_mask,
                    source_attention_mask=source_mask,
                ).squeeze(2)

            v = predict(cond)
            if do_cfg:
                v_uncond = predict(uncond)
                v = v_uncond + guidance_scale * (v - v_uncond)

            latents = scheduler.step(v.to(torch.float32), t, latents, return_dict=False)[0]

        images = model.decode_latents(latents, device=device, dtype=dtype)
        images = images.float().clamp(-1.0, 1.0)
        images = ((images + 1.0) * 127.5).round().to(torch.uint8)
        images = images.permute(0, 2, 3, 1).cpu().numpy()
        return [Image.fromarray(arr) for arr in images]
