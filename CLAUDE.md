# CLAUDE.md

This is a personal fork of [ostris/ai-toolkit](https://github.com/ostris/ai-toolkit) (a
diffusion LoRA/fine-tuning trainer with a Next.js UI). The fork adds personal-use features
on top of upstream without modifying upstream's training code.

**Read these two files before touching anything in this repo:**

- `FORK_NOTES.md` — the authoritative, always-current list of every place the fork diverges
  from upstream (which files are fork-only vs. upstream-modified, and the exact insertion
  points in the latter). This is what keeps `git merge upstream/main` a two-minute job —
  update it whenever a change adds a new upstream touchpoint or a new fork-only file.
- `PLAN.md` — the design history, phase by phase (Phase 1: presets + step suggestion. Phase
  2: dataset analyzer + per-arch advisor. Phase 3: research-backed recipe overhaul. Phase 4:
  Anima 2B architecture port). Read the relevant phase before changing advisor/recipe logic —
  it records *why* numbers are what they are and which are still contested/unverified, not
  just what they are.

For anything Anima-related, also read `ANIMA_INTEGRATION_SPEC.md` (the overall plan and its
gates) and `docs/anima_delta_catalog.md` (the A1 recon: architecture, training math, LoRA
key format, and the user's resolved decisions in §9).

## Fork hygiene rules (apply to any future change)

1. New functionality goes in new files. Upstream files should only ever get small,
   easy-to-reapply insertions (currently four files: JSX mounts in
   `ui/src/app/jobs/new/page.tsx` and `SimpleJob.tsx`, the AnimaModel registration in
   `extensions_built_in/diffusion_models/__init__.py`, and the Anima arch entry in
   `ui/src/app/jobs/new/options.ts` — see `FORK_NOTES.md` for the exact lines).
2. No Prisma schema changes for fork features — presets are files on disk (`presets/`), not
   DB rows.
3. After any change, verify `git diff upstream/main --stat` still only shows the upstream
   files listed in `FORK_NOTES.md` (plus whatever new fork-only files you added).
4. Update `FORK_NOTES.md`'s file list and `PLAN.md`'s relevant phase in the same commit as
   the code change — don't let them drift, they're the handoff mechanism for the next
   session/agent.

## Current state of the training advisor (`ui/src/utils/stepSuggestion.ts`)

This is the most actively-evolving part of the fork, so it's worth a specific note here on
top of `PLAN.md`'s Phase 3 section:

- Recipes (`ARCH_RECIPES`) are **not fixed per architecture** — they're keyed by dataset-size
  tier (`getSizeTier()`: small/medium/large by image count) because smaller datasets need
  lower rank/LR to avoid overfitting, per current community guides.
- `model.arch` alone cannot distinguish Illustrious-XL / Pony Diffusion from vanilla SDXL —
  all three report `arch: "sdxl"`. Detection is done by substring-matching
  `model.name_or_path` (`illustriousOrPonyRecipe()`). If you add support for another
  checkpoint family that shares an arch key with something else, follow this same pattern
  rather than trying to add a new arch string that the trainer doesn't actually have.
- Several recommended values are explicitly flagged in the `notes` field as low-confidence or
  genuinely contested in the source guides (e.g. Illustrious optimizer choice, Pony's
  `score_9` caption tag, all Flux2/Flux2-Klein numbers, which are FLUX.1 proxies). Do not
  quietly "resolve" these to a single confident number without new research backing it — the
  honesty about uncertainty is intentional, not a TODO to clean up.
- The LR scheduler (`lr_scheduler`) has no dedicated UI field anywhere else in this app; the
  advisor's Apply button is currently the only way a user sets it from the UI. If a proper
  scheduler dropdown is ever added to the main form, keep the advisor's suggestion in sync
  with it rather than fighting it.

## Current state of the Anima 2B port (Phase 4 / spec Workstream A)

Status as of 2026-07-12: **Workstream A is complete — A1 through A4 all passed.**
A3: zero key/shape diff + user-confirmed SwarmUI load. A4: matched-hyperparameter
loss-curve/sample parity vs TrainFlow and the Prodigy behavior check both pass —
see `docs/anima_a4_parity.md` (gate artifact, incl. the four documented benign
Prodigy construction differences). Next gates: Workstream C VRAM measurement, then
Workstream B QoL ports.

What exists and where:

- `extensions_built_in/diffusion_models/anima/` — the model extension. The DiT in
  `src/anima_transformer.py` is vendored byte-identical (per-class AST diff) from kohya
  sd-scripts v0.10.5; do not "clean it up" beyond the documented toolkit-integration
  dtype casts needed for bf16 weight storage (see PLAN.md Phase 4 A2 notes).
  `anima_model.py` holds AnimaModel and the LoRA key converters.
- `scripts/dump_lora_keys.py` — dump one LoRA or diff two; exit 0 only on zero
  key/shape mismatch (A3 automated check).
- Parity invariants that must NOT be changed casually (they exist to match kohya
  sd-scripts, which ComfyUI and the user's existing LoRAs depend on):
  - VAE encode uses the deterministic `latent_dist.mode()`, not `sample()` (Qwen-Image in
    this repo samples — Anima deliberately differs).
  - Dual tokenization, both padded to 512; T5 token ids are adapter inputs, never encoded.
  - LoRA export = sd-scripts keys (`lora_unet_<path with _>.lora_down/lora_up.weight` +
    per-module `alpha` == rank). This is spec HARD GATE A3.
  - LoRA targets class `Block` only; the LLM adapter is never trained (model author's
    explicit instruction); configs must carry
    `network.network_kwargs.ignore_if_contains: ["adaln_modulation"]`.
- Presets `presets/anima_lora_{performance,background}.json` carry the model author's
  recipe (rank 32, adamw 2e-5, sigmoid_scale 1.3 via `model.model_kwargs`); `background`
  (batch 1 + accum 4, low_vram) is the default for this shared 5090 machine.
- Reference material: TrainFlow clone expected at `W:\GitHub\Anima-TrainFlow` (vendored
  sd-scripts = ground truth for behavior questions); author's sample dataset + his
  diffusion-pipe config in `anima_sample_training/` (gitignored, 153 img/caption pairs).
- Training env: repo `.venv` (torch 2.10+cu130 + `requirements.txt`). A2 smoke artifact:
  `output/anima_a2_smoke/` (gitignored). A3 reference:
  `Anima-TrainFlow/training/output/a3_ref/a3_ref.safetensors`.

Next steps, in order (gates in `ANIMA_INTEGRATION_SPEC.md`):

1. **Workstream C gate**: measure VRAM in a live `background`-preset run (target ≤60–70%
   of 32GB).
2. **Workstream B**: QoL CLI ports (preflight, WD14 tagger, U2Net prep) — note B1/B4
   partially exist as UI features already; reconcile, don't duplicate (see
   `docs/ANIMA_INTEGRATION_UNDERSTANDING.md`).
