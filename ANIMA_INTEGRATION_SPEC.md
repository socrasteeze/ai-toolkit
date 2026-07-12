# SPEC: Anima 2B Integration + QoL Consolidation → ai-toolkit Fork

> **STATUS: COMPLETE** (2026-07-12). Every workstream and gate below shipped and
> passed. This doc is kept as the original requirements record — for current state,
> read `CLAUDE.md` first, then `PLAN.md` Phase 4 for the verification checklist and
> gate artifacts (`docs/anima_delta_catalog.md`, `docs/anima_a4_parity.md`,
> `docs/profiles.md`). Only TrainFlow retirement (item 8) is intentionally left to
> the user, who is handling it separately.

**Target repo:** `socrasteeze/ai-toolkit` (fork of `ostris/ai-toolkit`)
**Reference repo:** `socrasteeze/Anima-TrainFlow` (fork of `ThetaCursed/Anima-TrainFlow`)
**Objective:** Single trainer for all target architectures — SDXL/IllustriousXL, FLUX.2 Klein (4B/9B), Krea 2, Anima 2B — with TrainFlow's QoL features ported in. Retire TrainFlow to reference-only status on completion.

---

## Context

- ai-toolkit upstream already supports SDXL, FLUX.2 Klein 4B/9B, and Krea 2. The only missing architecture is **Anima 2B**.
- Anima-TrainFlow is a Gradio front-end wrapping a **modified sd-scripts** (kohya lineage) for Anima 2B. The backend modifications are the reference implementation for the port. The QoL layer (dataset analyzer, WD14 auto-captioning, U2Net smart crop, step suggestion, pre-flight validation) is the second port target.
- Output LoRAs are consumed by ComfyUI / SwarmUI. Existing TrainFlow-produced Anima LoRAs load correctly there — Comfy's Anima loader expects **sd-scripts key naming**. This is a hard compatibility constraint.

## Hardware Profile

- GPU: RTX 5090, 32 GB VRAM
- CPU: i7-13700KF
- RAM: 128 GB
- OS: Windows 10/11

**Constraint: do NOT tune everything to redline.** The user shares this machine with other work while training. All presets must ship in two profiles (see Workstream C).

---

## Workstream A — Anima 2B Model Extension

### A1. Recon / scoping (do this first)
1. Clone both repos locally.
2. Identify the sd-scripts base commit/version TrainFlow's modified backend derives from (check `training/` dir, CLAUDE.md, commit history).
3. Produce a **delta catalog**: every Anima-specific change vs vanilla sd-scripts. Categorize:
   - Model definition / architecture (transformer, text encoder, VAE)
   - Weight loading & checkpoint format
   - Noise/flow-matching objective, timestep sampling, loss target
   - LoRA target modules & injection points
   - Sampling/inference for preview generation
   - Tokenization / caption handling / any special conditioning
4. Write the catalog to `docs/anima_delta_catalog.md` in the ai-toolkit fork. This document scopes everything downstream — do not proceed to A2 without it.

### A2. Implement the model class
1. Study how existing comparable-scale models are integrated in ai-toolkit (Chroma, Lumina2, Qwen-Image are good references — model classes + `extensions_built_in/` pattern).
2. Implement `AnimaModel` following the toolkit `BaseModel` interface: loading, text encoding, latent encoding, noise prediction/flow target, sample generation.
3. Translate the delta catalog items — do not re-derive architecture from scratch; TrainFlow's backend is the source of truth for correctness.
4. Add config example under `config/examples/` and a preset under `presets/`.
5. Register the model in the UI model list.
6. **Exit criterion:** a LoRA training run completes end-to-end on a small test dataset without error. Quality irrelevant at this stage.

### A3. Export key parity — HARD GATE
1. Write `scripts/dump_lora_keys.py`: loads a safetensors LoRA, prints sorted key list + shapes.
2. Dump keys from a known-good TrainFlow Anima LoRA (user will provide one).
3. Dump keys from a toolkit-trained Anima LoRA.
4. Diff. **Zero mismatches required** (names and shapes). If toolkit-native naming differs, implement a key-remap on export so output matches sd-scripts convention exactly.
5. Add this comparison as an automated check (script or test) so future refactors can't silently break it.
6. Final validation: user loads the toolkit-trained LoRA in ComfyUI/SwarmUI and confirms it applies correctly.

### A4. Parity / quality validation
1. Same dataset, same seed where possible, matched hyperparameters (rank, alpha, LR/optimizer, steps, resolution): train once in TrainFlow, once in toolkit.
2. Compare loss curves and sample outputs at matching step counts.
3. Investigate any systematic divergence — usual suspects: timestep sampling distribution, loss weighting, noise schedule, text-encoder dropout, caption shuffling.
4. **Prodigy optimizer:** TrainFlow defaults to Prodigy. Verify toolkit's Prodigy implementation/behavior matches (d-coef handling, safeguard settings). Document any intentional differences.

---

## Workstream B — QoL Port (from TrainFlow)

Port as Python CLI/pre-flight tools first; UI integration second. Keep them decoupled from any single architecture — they should serve SDXL/Klein/Krea/Anima datasets alike.

### B1. Dataset pre-flight validator
- Port TrainFlow's checks: missing captions, oversized images, missing/invalid model paths, unsupported formats.
- Deliver as `scripts/preflight.py <dataset_dir> [--config <job.yaml>]`, exit nonzero on failure.
- Wire into the job launch path so a failing pre-flight blocks queue submission (configurable override flag).

### B2. Auto-captioning (WD14 / EVA02-large-tagger-v3)
- Port the multi-threaded tagger with general/character threshold options.
- `scripts/auto_caption.py <dataset_dir> --general-thresh --char-thresh --trigger-word`.
- Model weights pulled from HF on first run; cache locally.

### B3. Smart resize/crop (U2Net subject-aware)
- Port the bucket-aware resize + extreme-aspect-ratio crop logic. Note: ai-toolkit already buckets and never requires cropping — position this as an *optional* dataset prep tool, not a mandatory step.
- `scripts/smart_prep.py <in_dir> <out_dir> --buckets <profile>`.

### B4. Step/schedule suggestion
- Port TrainFlow's suggest-steps logic (see `atf_SUGGEST_STEPS_BRIEF.md` and `atf_PRESETS_BRIEF.md` in the TrainFlow repo).
- Extend to per-architecture heuristics (dataset size → steps/epochs/repeats recommendation).
- Surface as CLI output first; UI hint later.

### B5. (Phase 2, optional) UI integration
- Toolkit UI is Next.js/TypeScript under `ui/`. Add a "Dataset Tools" panel invoking B1–B4. Only after CLI versions are stable.

---

## Workstream C — Training Profiles (headroom-aware)

Ship **two named profiles per architecture**, selectable in config/preset:

### `performance` profile
- Tuned for the 5090: full BF16, no quantization for Anima 2B / Klein 4B / SDXL, batch size and resolution buckets sized to use most of 32 GB VRAM.
- Krea 2 / Klein 9B: quantize/offload only if measurement shows it's needed.

### `background` profile (default for Anima/SDXL)
- Deliberately leaves headroom for concurrent desktop use:
  - Target ≤ ~60–70% VRAM utilization (leave 9–12 GB free).
  - Smaller batch size + gradient accumulation to preserve effective batch.
  - Cap dataloader workers (e.g., 4) and set process priority below normal on Windows where feasible.
  - Latent/text-embed caching ON to reduce sustained compute spikes.
- Document expected wall-clock cost vs `performance` so the tradeoff is visible.

Implementation notes:
- Profiles are preset YAMLs, not code forks: `presets/anima_performance.yaml`, `presets/anima_background.yaml`, etc.
- Add a short `docs/profiles.md` explaining the two modes and how to switch mid-project.
- Do not hardcode 5090 assumptions into the model class — keep hardware tuning in presets only.

---

## Execution Order & Gates — all PASSED, artifacts in `PLAN.md` Phase 4

1. [x] **A1** delta catalog → `docs/anima_delta_catalog.md`.
2. [x] **A2** model class → end-to-end run completed.
3. [x] **A3** key parity → HARD GATE: zero key diff + user-confirmed SwarmUI load.
4. [x] **A4** quality parity → `docs/anima_a4_parity.md` (loss curves + samples within
   noise, Prodigy behavior verified).
5. [x] **B1–B4** QoL CLI tools → `scripts/preflight.py`, `auto_caption.py`,
   `smart_prep.py`; B4 reconciled into the existing `stepSuggestion.ts` advisor.
6. [x] **C** profiles → `docs/profiles.md` (background preset: 30–33% steady /
   43% peak of 32GB, target was ≤60–70%).
7. [x] **B5** UI integration → `DatasetTools.tsx` panel (pre-flight kept
   advisory-only by deliberate decision, see PLAN.md Phase 4 note).
8. [ ] Retire TrainFlow: user is handling this separately; `Anima-TrainFlow`
   clone stays untouched (it hosts the A3/A4 reference artifacts).

## Ground Rules for the Agent

- TrainFlow's modified sd-scripts is the **source of truth** for Anima correctness. When toolkit conventions and TrainFlow behavior conflict on anything affecting training math or export format, TrainFlow wins unless explicitly overridden.
- No upstream-breaking changes: keep the fork mergeable with `ostris/ai-toolkit` where practical (extension pattern, minimal core edits).
- Windows is the deployment target. Test scripts/paths accordingly.
- Every gate produces an artifact: catalog doc, key-diff output, loss-curve comparison, VRAM measurement. No gate passes on assertion alone.
- Ask before: changing LoRA export format, altering shared/core toolkit code, or adding heavyweight dependencies.
