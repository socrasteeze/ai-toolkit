# Anima 2B Delta Catalog (Workstream A1 artifact)

Produced 2026-07-12 from file-level recon of `socrasteeze/Anima-TrainFlow` (vendored
sd-scripts backend), cross-checked against `tdrussell/diffusion-pipe`'s independent Anima
implementation and surveyed against this repo's integration points. This document scopes
Workstreams A2–A4 of `ANIMA_INTEGRATION_SPEC.md`. **Status: A1 reviewed and approved
2026-07-12 (decisions in §9); A2 implementation landed the same day — see PLAN.md
Phase 4 for what was built. Next gates: A2 end-to-end run, then A3 key parity.**

---

## 0. Headline finding: the "delta" is almost empty — Anima support is upstream kohya

The spec assumed TrainFlow ships a *modified* sd-scripts whose Anima changes needed
cataloging. Recon shows otherwise:

- TrainFlow's vendored backend is **kohya-ss/sd-scripts `main` @ `a1b48df` (v0.10.5,
  2026-05-08)** — pinned as a git submodule in TrainFlow's initial commit, later vendored
  as plain files. Identification is certain (full-tree diff).
- **Anima support is native upstream kohya code** ("Anima preview" is in upstream's
  supported-models list at that commit; upstream Anima PRs: #2297, #2302 fp16 stability,
  #2317 LLLite, #2359, #2378, #2379, #2382). TrainFlow's author wrote none of it.
- TrainFlow's actual deltas vs upstream are **packaging-only** (7 files): a `sys.path`
  shim in `anima_train_network.py`, cache-directory relocation in `strategy_anima.py`
  (`cache_text_encoder/`, `latent_cache/` subdirs), a backport of upstream PR #2359's
  device fix to four `lora_*.py` files, and requirements pins. **Zero effect on training
  math or export format.**

**Consequences for the spec:**
1. The correctness reference is upstream **kohya-ss/sd-scripts**, which is actively
   maintained (0.11.x contains further Anima fixes we should review during A2).
2. The A4 "parity vs TrainFlow" gate is really "parity vs sd-scripts v0.10.5+".
3. TrainFlow remains the reference for the *QoL layer* (Workstream B) and its `app.py`
   defaults (Prodigy, hidden settings) — but not for model code.

Anima itself: by **Circlestone Labs** (`circlestone-labs/Anima` on HF), architecture is
NVIDIA **Cosmos-Predict2 "MiniTrainDIT"** with a Qwen3-0.6B text encoder, a learned LLM
Adapter, and the Qwen-Image (Wan 2.1-architecture) VAE. Checkpoint: `anima-preview3-base`.

---

## 1. Model composition

| Component | What it is | Weights location |
|---|---|---|
| DiT | Cosmos-Predict2 MiniTrainDIT, 2B: 2048 dim, 28 blocks, 16 heads (head_dim 128), patch 2×2×1, rectified flow | DiT safetensors (ComfyUI `net.` prefix) |
| LLM Adapter | 6-layer transformer bridge: T5 token IDs (queries) cross-attend into Qwen3 hidden states → 1024-dim T5-compatible cross-attn embeddings | **Inside the DiT file** (`llm_adapter.*` keys; sentinel `llm_adapter.out_proj.weight`) |
| Text encoder | Qwen3-0.6B backbone (`AutoModelForCausalLM(...).model`, LM head dropped), hidden 1024, always frozen | separate safetensors or HF dir |
| VAE | Qwen-Image VAE = Wan 2.1 3D causal KL-VAE, base_dim 96, z_dim 16, 8× spatial downscale, 5D tensors `(B,16,T=1,H/8,W/8)` | separate safetensors |
| Tokenizers | Qwen3 tokenizer (for TE input) **and** T5 tokenizer from `google/t5-v1_1-xxl` vocab (adapter target IDs only — no T5 model ever runs) | bundled configs (`qwen3_06b/`, `t5_old/`) |

The non-obvious piece: the DiT's cross-attention space is **T5-token-indexed**. Every
caption is tokenized twice; the adapter embeds the T5 IDs via a learned
`nn.Embedding(32128, 1024)` and cross-attends into the Qwen3 hidden states, producing the
`crossattn_emb` the DiT consumes. A T5 tokenizer is required; a T5 model is not.

## 2. DiT architecture (sd-scripts `library/anima_models.py`)

Fixed 2B config (the working loader hardcodes it; a shape-based auto-detector exists but is
commented out — reference for multi-size support: model_channels 2048→28 blocks/16 heads,
5120→36/40, 1280→20/20):

```
in/out_channels=16, patch_spatial=2, patch_temporal=1, model_channels=2048
concat_padding_mask=True, crossattn_emb_channels=1024
pos_emb_cls="rope3d", rope_h/w_extrapolation_ratio=4.0, rope_t=1.0
use_adaln_lora=True, adaln_lora_dim=256, num_blocks=28, num_heads=16
extra_per_block_abs_pos_emb=False, use_llm_adapter=True
```

- **PatchEmbed** `x_embedder`: input = 16 latent + 1 padding-mask channel = 17;
  `Linear(17·2·2·1=68 → 2048, bias=False)`. Key `x_embedder.proj.1.weight [2048, 68]`.
  No bias anywhere in the DiT.
- **Timestep embedding** `t_embedder`: sinusoidal `Timesteps(2048)` →
  `linear_1(2048→2048, no bias)`, SiLU, `linear_2(2048→3·2048, no bias)`. Outputs the
  timestep embedding *and* a shared `adaln_lora_B_T_3D` that every block's modulation adds
  to. `t_embedding_norm` = RMSNorm(2048, eps 1e-6) on the embedding only.
- **Block** (`blocks.N.`, ×28): order self-attn → cross-attn → MLP; each sublayer
  `x = x + gate · f(LN(x)·(1+scale)+shift)`. Non-affine LayerNorms. MLP =
  `GPT2FeedForward` 2048→8192→2048, GELU, no bias. Three AdaLN-LoRA modulations
  (`adaln_modulation_{self_attn,cross_attn,mlp}` = SiLU → Linear(2048→256) →
  Linear(256→6144), no bias), each output += shared adaln_lora, then chunk(3) →
  shift/scale/gate. Modulation math forced to fp32 under fp16 autocast.
- **Attention**: QK-RMSNorm per head (`q_norm`/`k_norm` RMSNorm(128)); `q/k/v_proj`,
  `output_proj` all bias-free; cross-attn k/v project from context dim 1024. 3D RoPE
  (axis split head_dim 128 → h:42, w:42, t:44, NTK-by-parts with ratio 4.0 spatial) applied
  to **self-attn q,k only**, non-interleaved rotate-half.
- **FinalLayer**: non-affine LN, `linear(2048 → 2·2·1·16=64, no bias)`, modulation with
  only **shift+scale (no gate)**, adds `adaln_lora[:, :, :2·2048]`.
- Unpatchify: `B T H W (p1 p2 t C) → B C (T t) (H p1) (W p2)`.
- Forward: padding_mask (zeros for images) resized NEAREST and concatenated as the 17th
  channel; **the LLM adapter runs inside the DiT forward** (upstream comment: required for
  DDP grad sync); after adapter, `context[~t5_attn_mask] = 0`.
- Checkpoint I/O: ComfyUI `net.` prefix stripped on load, re-added on save
  (`metadata["format"]="pt"`). Expected-missing buffers on load: `seq`,
  `dim_spatial_range`, `dim_temporal_range`, adapter `inv_freq`.

## 3. LLM Adapter (`llm_adapter.*`)

`LLMAdapter(source_dim=1024, target_dim=1024, model_dim=1024, num_layers=6,
self_attn=True)`, 16 heads, head_dim 64:

- `embed` = `nn.Embedding(32128, 1024)` (T5 vocab), `in_proj` = Identity,
  `rotary_emb` (LLaMA-style, θ=10000), 6 × block, `out_proj` = Linear(1024,1024, **with**
  bias) — sentinel key — and final RMSNorm.
- Each block: RMSNorm → self-attn over T5-target tokens (T5 mask) → RMSNorm → cross-attn
  into Qwen3 hidden states (Qwen3 mask, context-position RoPE on keys) → RMSNorm → MLP
  1024→4096→1024 GELU (**with** bias, unlike the DiT).
- diffusion-pipe corroborates the identical structure and notes the adapter MLP output is
  zero-initialized in the original.

## 4. VAE (Qwen-Image / Wan 2.1)

- `AutoencoderKLQwenImage`: base_dim 96, z_dim 16, dim_mult [1,2,4,4], num_res_blocks 2,
  temporal downsample [F,T,T] → spatial compression 8. 3D causal convs; image mode uses a
  singleton temporal axis.
- **Encode = `posterior.mode()` — deterministic, not sampled** — then per-channel
  normalization `(z − mean) / std` with fixed 16-element vectors (identical constants in
  sd-scripts and diffusion-pipe, i.e. standard Wan 2.1 values):
  - mean: `[-0.7571, -0.7089, -0.9113, 0.1075, -0.1745, 0.9653, -0.1517, 1.5508, 0.4134, -0.0715, 0.5517, -0.3632, -0.1922, -0.9497, 0.2503, -0.2921]`
  - std: `[2.8184, 1.4541, 2.3275, 2.6558, 1.2196, 1.7708, 2.6052, 2.0743, 3.2687, 2.1526, 2.8652, 1.5579, 1.6382, 1.1253, 2.8251, 1.9160]`
- Decode inverts (`z·std + mean`), clamps to [-1,1]. Pixels pre-normalized to [-1,1] by the
  caller.
- Memory options in sd-scripts: spatial chunking (`--vae_chunk_size`), internal-cache
  disable (`--vae_disable_cache`), tiling, slicing.

## 5. Text pipeline & training math (sd-scripts, corroborated by diffusion-pipe)

**Tokenization**: both tokenizers, `truncation=True, padding="max_length", max_length=512`
(both), **no chat template, no prefix** — raw caption verbatim. Qwen3 pad=eos if unset.

**Encoding**: Qwen3 backbone `last_hidden_state`; padded positions hard-zeroed
(`prompt_embeds[~mask] = 0`). Tuple carried through training:
`(prompt_embeds, qwen3_attn_mask, t5_input_ids, t5_attn_mask)`.

**TE output caching**: five arrays per sample incl. a stored per-sample
`caption_dropout_rate`. Dropout decision is a **fresh Bernoulli draw each train step**
against the cached rate (this is why caption dropout composes with TE caching — currently
an Anima-only feature upstream). Unconditional replacement on drop: zeroed embeds+mask,
T5 ids `[1, 0, 0, …]` (single `</s>` EOS), T5 mask `[1, 0, 0, …]`.

**Objective — standard rectified flow** (diffusion-pipe author explicitly dropped NVIDIA
Cosmos' `t²+(1−t)²` implicit weighting; sd-scripts likewise applies none):

```
sigmas ~ sampler (see below), timesteps = sigmas · 1000
noisy  = (1 − σ)·x₀ + σ·ε
model input t = timesteps / 1000  ∈ [0,1]        # DiT receives [0,1]
target = ε − x₀                                   # velocity
```

**Timestep sampling** (`--timestep_sampling`, default `sigmoid`, `sigmoid_scale=1.0`,
`discrete_flow_shift=1.0`):

| mode | σ formula |
|---|---|
| `uniform` | `rand()` |
| `sigmoid` (default) | `sigmoid(scale · randn())` — ≡ diffusion-pipe's default `logit_normal` |
| `shift` | `s = sigmoid(scale·randn)`; `σ = s·shift / (1 + (shift−1)·s)` |
| `flux_shift` | resolution-aware: `mu = lin(256→0.5, 4096→1.15)((h/2)(w/2))`, `σ = e^mu / (e^mu + (1/s − 1))` |
| `sigma`/weighted | scheduler-index path with `logit_normal` / `mode` densities |

`sigmoid_scale > 1` widens the logit-normal (more mass at extreme timesteps). The
sample config trained on diffusion-pipe used `sigmoid_scale = 1.3`; sd-scripts default is
1.0 — a preset decision, not a correctness issue.

**Loss**: per-element MSE (l1/huber/smooth_l1 selectable) × optional weighting
(`sigma_sqrt` = σ⁻², `cosmap` = 2/(π(1−2σ+2σ²)), else 1) → mean over CHW → per-sample
loss_weights → mean. **`post_process_loss` is identity** — no SNR/v-pred/debias reweighting
on the Anima path. No multiscale loss in sd-scripts (diffusion-pipe has an optional
`multiscale_loss_weight`; not needed for parity).

**Preview sampling**: Euler over `linspace(1, 0, steps+1)` with inference shift
`σ' = σ·shift / (1+(shift−1)σ)`, defaults **steps 30, CFG 7.5, flow_shift 3.0**, dims
snapped to multiples of 16; CFG = `neg + scale·(pos − neg)`; uncond = the EOS-token
representation above.

**Other**: fp8_base unsupported (force-disabled); bucket resolution divisibility **16**
(VAE 8 × patch 2); per-component LR groups (self_attn / cross_attn / mlp / mod /
llm_adapter / base; lr=0 freezes — diffusion-pipe docs recommend freezing the adapter for
small datasets).

## 6. LoRA targeting & export keys (A3 hard gate)

**Targeting** (`networks/lora_anima.py`): module classes
`["Block", "PatchEmbed", "TimestepEmbedding", "FinalLayer"]` (+
`["LLMAdapterTransformerBlock"]` only with `train_llm_adapter=True`; Qwen3 TE classes only
when TE training enabled). Only `Linear`/`Conv2d` children wrapped. Default exclude regex
appended unconditionally:

```
.*(_modulation|_norm|_embedder|final_layer).*
```

→ effective default targets are exactly the **`self_attn`, `cross_attn`, `mlp` linears in
the 28 DiT blocks**. `include_patterns` overrides excludes; `network_reg_dims`/
`network_reg_lrs` give per-regex rank/LR. Default `network_alpha = 1.0`.

**sd-scripts key scheme** (what ComfyUI's Anima loader accepts for DiT-only LoRAs, and what
our export must produce byte-for-byte):

```
lora_name = f"{prefix}.{original_name}".replace(".", "_")
# prefix "lora_unet" (DiT) / "lora_te" (Qwen3; single TE, not te1/te2)
blocks.0.self_attn.q_proj →
  lora_unet_blocks_0_self_attn_q_proj.lora_down.weight
  lora_unet_blocks_0_self_attn_q_proj.lora_up.weight
  lora_unet_blocks_0_self_attn_q_proj.alpha          # scalar tensor, scale = alpha/rank
```

Metadata on save: trainer-assembled `ss_*` (incl. `ss_timestep_sampling`,
`ss_sigmoid_scale`, `ss_discrete_flow_shift`, `ss_weighting_scheme`, `ss_logit_*`,
`ss_mode_scale`) + `sshs_model_hash`/`sshs_legacy_hash`.

**ComfyUI-native alternative**: `convert_anima_lora_to_comfy.py` renames to
`diffusion_model.blocks.0.self_attn.q_proj.lora_A|lora_B.weight` (+
`text_encoders.qwen3_06b.transformer.model.` for TE keys). Per upstream docs the conversion
is **only needed for Qwen3-TE LoRAs; DiT-only sd-scripts LoRAs load in ComfyUI directly**.
diffusion-pipe exports the ComfyUI/PEFT format natively — so ComfyUI accepts **both**
formats for DiT LoRAs. Per the spec, our A3 target is the sd-scripts format (matches the
user's existing TrainFlow LoRAs); supporting the ComfyUI format as a secondary export is
cheap if ever wanted.

Conversion fragility note: the converter's dot/underscore re-join uses a fixed ordered
replace list — a reason to diff against a *real* reference LoRA, not against inferred names.

## 7. Cross-check: sd-scripts vs diffusion-pipe (two independent implementations)

Agreements (strong confirmation of the math): identical architecture + config-detect table,
identical VAE constants and `mode()` encode, identical adapter structure, dual tokenization
@512 with padded-position zeroing, `target = ε − x₀`, same shift formulas, adapter-in-DiT
sentinel key, `net.` checkpoint prefix.

Differences (defaults/features, not math): dp defaults `logit_normal` ≡ sd-scripts
`sigmoid`; dp has optional multiscale loss; dp exports PEFT/ComfyUI keys vs sd-scripts
keys; dp lacks the caption-dropout-rate-in-cache mechanism. dp docs note Anima "may need a
lower learning rate than other models."

## 8. Port mapping into ai-toolkit (scopes A2)

All hooks exist; **no core-file edits required**:

| Piece | Landing spot |
|---|---|
| Model class | new `extensions_built_in/diffusion_models/anima/` — `AnimaModel(BaseModel)`, `arch="anima"`, vendored MiniTrainDIT under `src/` (template: `example_model/`, which documents every override; `omnigen2`/`boogu_image` for the LLM-bridge shape) |
| Registration | import + append in `extensions_built_in/diffusion_models/__init__.py` (no `ModelArch` Literal change needed — resolution is by class `arch` attr via `toolkit/util/get_model.py`) |
| VAE | diffusers `AutoencoderKLQwenImage` reused from the Qwen-Image integration, with its per-channel mean/std normalization — **but switch to `mode()`**: `qwen_image.py:429-462` *samples* the latent dist; Anima parity requires the deterministic mode |
| Text encoder | stock `transformers` Qwen3 (`AutoModelForCausalLM(...).model`); Qwen-Image's Qwen2.5-VL class is not reusable |
| Adapter | implement inside the vendored DiT (as upstream does; `toolkit/models/llm_adapter.py` is flux/lumina2-only and unrelated) |
| Flow matching | `CustomFlowMatchEulerDiscreteScheduler` via static `get_train_scheduler()`; `timestep_type` default `sigmoid` already matches Anima's default; `get_loss_target` → `(noise − latents).detach()` (already the flow-match default) |
| LoRA targeting | `self.target_lora_modules = ["Anima"(DiT class name)]`, `get_transformer_block_names() → ["blocks"]`, `ignore_if_contains` for modulation/norm/embedder/final_layer to mirror the default exclude |
| **Key export (A3)** | `convert_lora_weights_before_save/_load` overrides producing sd-scripts `lora_unet_*` keys — richest precedent: `toolkit/models/wan21/wan_lora_convert.py`; toolkit-internal PEFT names (`lora_A/lora_B`, `transformer.` prefix) map 1:1 |
| Alpha caveat | toolkit's PEFT-format save **drops `alpha` keys**; sd-scripts format requires per-module `alpha` (scale=alpha/rank). Export remap must re-synthesize alpha tensors (constant = network alpha). Needs care in A3. |
| UI | arch entry in `ui/src/app/jobs/new/options.ts` (+ Anima recipe in `ui/src/utils/stepSuggestion.ts` `ARCH_RECIPES`) |
| Config/presets | `config/examples/train_lora_anima_32gb.yaml`; `presets/anima_{performance,background}` (existing fork presets are JSON — reconcile with spec's YAML naming) |
| Prodigy | already supported (`toolkit/optimizer.py` → `prodigyopt.Prodigy`, lr auto-bump to 1.0); A4 compares its behavior vs TrainFlow's Prodigy invocation (`safeguard_warmup=True`, constant schedule per TrainFlow `app.py`) |

Bucket divisibility: 16 (VAE 8 × patch 2) → `get_bucket_divisibility()`.

## 9. Open questions — RESOLVED at A1 review (2026-07-12)

User decisions:

1. **Base semantics**: port v0.10.5 behavior; selectively review upstream 0.11.x Anima PRs
   for correctness fixes and document any adoption.
2. **Caption dropout + cached TE**: deferred — dropout disabled when caching (like other
   toolkit archs). Note: per Circlestone's finetuning tips this is a light-touch model;
   dropout is not a load-bearing feature for LoRA training.
3. **`sigmoid_scale`**: presets default to **1.3** — the Anima author's own config value
   (the author of Anima IS tdrussell, diffusion-pipe's author, per the "My own training
   script, diffusion-pipe" line in Circlestone's finetuning tips). sd-scripts default of
   1.0 noted as the alternative.

**Author's finetuning tips (Circlestone Labs), binding for presets/advisor:**
- Do NOT train the LLM adapter (it processes text embeddings before the DiT, has outsized
  influence, contains a lot of knowledge, easy to degrade). `llm_adapter_lr=0` /
  train_llm_adapter off by default.
- Low LR: rank-32 LoRA starts at **2e-5**, adjust from there.
- Base model: no aesthetic tuning/RLHF to overcome; huge concept coverage already — a
  light touch is all you need.

### Original open questions (for the record)

1. **Sync to newer upstream?** Base is v0.10.5; upstream 0.11.x has additional Anima fixes
   (#2359 already backported in TrainFlow; #2378/#2379/#2382 not). Proposal: port from
   v0.10.5 semantics (what the user's existing LoRAs were trained with), review the later
   Anima PRs for correctness fixes worth adopting, document any adoption.
2. **Latent-dist sampling vs mode()**: parity requires `mode()`; deviating from the
   toolkit's Qwen-Image `sample()` habit is deliberate and should be commented.
3. **Caption dropout with cached TE**: ai-toolkit's TE-embedding cache path needs the
   store-rate/draw-at-step mechanism if we want dropout + caching together (background
   profile caches embeds). Decide whether to implement in A2 or defer (dropout off when
   caching, like other toolkit archs).
4. **LLM adapter training**: default OFF (matches both references' recommendation for
   small datasets); expose as an option later if needed.
5. **A3 reference artifact**: user opted to have us self-produce a TrainFlow LoRA at that
   stage (~20 junk steps on `anima_sample_training/`); requires the Anima base weights +
   TrainFlow env on this machine.
6. **`sigmoid_scale` preset value**: sd-scripts default 1.0 vs the sample diffusion-pipe
   config's 1.3 — pick per-profile in Workstream C, flag as contested in the advisor
   (consistent with fork policy on uncertain numbers).

## 10. Reference materials

- TrainFlow clone: `W:\GitHub\Anima-TrainFlow` (vendored sd-scripts at
  `training\sd-scripts`)
- Upstream comparison clone + diffusion-pipe clone: session scratchpad (temporary)
- Sample dataset + known-good diffusion-pipe config: `anima_sample_training/` (gitignored)
- Anima weights: HF `circlestone-labs/Anima` (`anima-preview3-base.safetensors`,
  `qwen_image_vae.safetensors`, `qwen_3_06b_base.safetensors`)
