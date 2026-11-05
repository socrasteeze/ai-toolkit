# HANDOFF

**Updated:** 2026-11-05 · **Branch:** main · **Base:** 4d0a1c43 · **Owner:** Codex (implement) · ATK Bot (wrote handoff only)

## Goal
Unblock **Concept Slider** training on models that require control images, especially **Qwen-Image-Edit** and **Qwen-Image-Edit-Plus**. Same bug also blocks Krea 2 / Klein (flux2) when a dataset has controls. Plain text-to-image (Qwen-Image, Anima, Krea/Klein without controls) already works through the shared path; do not break those.

## Background
- Current trainer: `extensions_built_in/concept_slider/ConceptSliderTrainer.py`, job type `concept_slider` (UI: New Job → Concept Slider).
- It learns from four prompts (`positive_prompt`, `negative_prompt`, `target_class`, optional `anchor_class`), not from before/after image pairs. Dataset images only supply noisy latents.
- In `get_guided_loss` it stacks latents/timesteps by `num_embeds` (3 or 4) for a no-grad combo prediction, and by 2 when an anchor is set for the train passes, but still passes the original `batch=` into `predict_noise`.
- Models that read control from `batch` then see `latents.shape[0] == N * batch_size` while `batch.control_tensor` / `control_tensor_list` still have length `batch_size`.

## Bug sites (trainer)
File: `extensions_built_in/concept_slider/ConceptSliderTrainer.py`

1. **No-grad combo** (~157–164): `latents=torch.cat([noisy_latents] * num_embeds)`, `timestep` likewise, `batch=batch` unchanged.
2. **Anchor train path** (~225–228): doubles `noisy_latents` and `timesteps`, then positive (~234–240) and negative (~268–274) `predict_noise` still pass the original `batch`.

## Why Edit / controls fail
- **Qwen-Image-Edit** (`extensions_built_in/diffusion_models/qwen_image/qwen_image_edit.py`): `condition_noisy_latents` channel-cats `batch.control_tensor` latents onto the noisy latents. After the slider stacks the noisy latents, control batch dim no longer matches → pack/chunk or shape errors in `get_noise_prediction`.
- **Qwen-Image-Edit-Plus** (`.../qwen_image_edit_plus.py`): `get_prompt_embeds` requires control images and asserts `len(prompt) == len(control_images)` (~196–197). Stacked prompt/latent batches without expanded controls fail that check (and related training encoding ~178+).
- **Krea 2** (`.../krea2/krea2.py` ~544–549): `len(control_list) != batch_size` when latents were stacked.
- **Klein / flux2** (`.../flux2/flux2_model.py` ~304–326): same `len(batch_control_tensor_list) != batch_size` pattern.

Do **not** special-case each model in the model files if a single fix in the slider trainer can expand the batch. Prefer fixing `ConceptSliderTrainer` so every model that consumes `batch` stays consistent.

## Required fix
In `ConceptSliderTrainer.get_guided_loss`, whenever latents (and timesteps / embeds) are stacked to size `k * B`, pass a batch whose control fields are expanded the same way:

- Expand / repeat: `control_tensor` (dim 0), `control_tensor_list` (outer list length), and any other per-sample fields models read for conditioning (e.g. tensors used by Edit-Plus multi-control). Prefer a small helper that clones a `DataLoaderBatchDTO`-compatible object or shallow-copies and repeats those fields; do not mutate the dataloader's live batch in place across steps.
- Apply for:
  - combo no-grad call: factor `num_embeds` (3 or 4)
  - train calls when anchor is set: factor `2`
  - train calls with no anchor: factor `1` (batch can stay as-is)
- Keep `guidance_scale=1.0` / `guidance_embedding_scale=1.0` as today.
- Do not change the loss math (enhance/erase/anchor) unless a test proves it is wrong.
- Ghost policy is active in this repo: no real dataset file/folder names in commits, comments, tests, or docs. Use generic fixture names only.

## Out of scope
- Do not rewrite the legacy trainers (`jobs/process/TrainSliderProcess*.py`, `ultimate_slider_trainer`, `image_reference_slider_trainer`).
- Do not add a Flux/Qwen example YAML unless it is generic (no real paths).
- Do not push. Local commits only unless Adam asks.
- No `.bak` files. Do not touch `_Archive` or IRL dataset folders. Do not stop running training jobs or the UI.
- ATK Bot does not edit the repo; Codex (or headless Grok Build) implements.

## Verify
1. `python -m py_compile extensions_built_in/concept_slider/ConceptSliderTrainer.py` (venv python).
2. If you add a unit test, put it under `testing/` with **synthetic** tensors only (no real images). Assert that a helper expanding a fake batch with `control_tensor` of shape `(B,C,H,W)` to factor `k` yields `(k*B,C,H,W)`, and that `control_tensor_list` of length `B` becomes length `k*B`.
3. Manual smoke (Adam or ATK Bot after the fix lands): Concept Slider job on **Qwen-Image-Edit** (or Edit-Plus), ~50 steps, rank 4–8, prompts e.g. target `a person` / positive `a woman` / negative `a man` / optional anchor, dataset with control images present. Job must complete without shape/assert errors. Optional: also confirm plain Qwen-Image (no controls) still trains.
4. Quick fork check if convenient: `scripts/verify_fork.py`. No full suite / next build / npm test unless asked.

## Suggested first commit message
`Fix concept slider batch expansion for control/edit models`

## Notes for the implementer
- UI wiring already exists (`ui` job type Concept Slider + Slider card). No UI change required for the fix.
- Cache Text Embeddings can stay on for slider runs; slider prompts are encoded once up front in the trainer.
