# Fork Enhancement Plan

Phase 1 (shipped): Presets + Suggested Step Count.
Phase 2 (this plan): Dataset Analyzer + Per-Arch Training Advisor, ported from
[socrasteeze/Anima-TrainFlow](https://github.com/socrasteeze/Anima-TrainFlow).

Personal-use enhancements for this fork of [ostris/ai-toolkit](https://github.com/ostris/ai-toolkit).
This document is the implementation plan; `FORK_NOTES.md` tracks the actual merge surface
against upstream.

## Context

- The fork started as a clean mirror of upstream (0 ahead / 0 behind at commit `f63221e`).
- The UI is a Next.js 15 App Router app (`ui/`) with Prisma + SQLite (`aitk_db.db`). A job
  config is a plain `JobConfig` JSON blob (`ui/src/types.ts`) stored in `Job.job_config`,
  written to `output/<job>/.job_config.json` by `ui/cron/actions/startJob.ts`, and passed to
  `python run.py`.
- Training is strictly step-bounded: `jobs/process/BaseSDTrainProcess.py` loops
  `for step in range(start, train.steps)`. The dataloader wraps infinitely; `epoch_num` is
  only a counter and `num_repeats` is a file-list multiplier (`toolkit/data_loader.py`).
  Nothing converts image count to steps — that is the gap Feature B fills.
- IllustriousXL is an SDXL checkpoint: `model.arch: 'sdxl'` + a different
  `model.name_or_path`. No Python changes are needed for either feature.

## Guiding principles (fork hygiene)

1. New code goes in new files; upstream can't conflict with files it doesn't have.
2. Upstream files are touched at exactly two insertion points, each 1–5 lines
   (see `FORK_NOTES.md`).
3. No Prisma schema changes — presets are files on disk, not DB rows.
4. Loading any preset runs upstream's own `migrateJobConfig()`, so upstream config-format
   changes keep old presets working.
5. Sync with `git fetch upstream && git merge upstream/main`; each feature is its own commit.

## Feature A: Training config presets

A preset is a `JobConfig` JSON/YAML file in the `presets/` folder at repo root. Drop any
ai-toolkit config file (UI export or CLI-style YAML from `config/examples/`) into the folder
and it appears in the UI.

New files:

| File | Purpose |
|---|---|
| `ui/src/server/presetsPath.ts` | `getPresetsRoot()` — optional `PRESETS_FOLDER` Settings key, default `<repo>/presets`, mkdir if missing |
| `ui/src/app/api/presets/route.ts` | `GET` list presets, `POST { name, config }` save |
| `ui/src/app/api/presets/[name]/route.ts` | `GET` read+parse (JSON/JSONC/YAML), `DELETE` remove |
| `ui/src/utils/presets.ts` | `configToPreset()` strips machine-specific fields (job name, dataset paths, training folder); `applyPreset()` migrates + merges while preserving the current form's name, dataset paths, and runtime fields |
| `ui/src/components/PresetManager.tsx` | "Presets" button + modal: list/load/delete + save-current-as-preset |
| `presets/*.json` | Starter presets (IllustriousXL character/style LoRA, Flux LoRA) |

Upstream edit: mount `<PresetManager/>` in the TopBar of `ui/src/app/jobs/new/page.tsx`.

Semantics:
- **Save**: deep-copy the form config; reset `config.name` to a placeholder, reset each
  dataset's `folder_path` to the default placeholder (dataset *settings* like resolution,
  num_repeats, caption options are kept — they are part of the recipe), reset
  `training_folder`/`sqlite_db_path`/`device` so shared presets don't leak local paths.
- **Load**: parse → `migrateJobConfig()` → apply over the current form, preserving the
  current `config.name`, current dataset `folder_path`s (mapped by index), and the runtime
  fields (`training_folder`, `sqlite_db_path`, `device`, `performance_log_every`) exactly as
  the existing Import Config flow does.

## Feature B: Suggested step count

When datasets and an architecture are selected in the new-job form, count files in the
selected dataset folders and show an advisory suggestion next to the Steps field with an
"Apply" button. Never auto-applies.

New files:

| File | Purpose |
|---|---|
| `ui/src/server/datasetFiles.ts` | `countDatasetFiles()` — recursive count using the same media-extension whitelist as `listImages`, skipping dotfiles and `_controls` (matches trainer enumeration in `toolkit/data_loader.py`) |
| `ui/src/app/api/datasets/count/route.ts` | `POST { datasetName }` → `{ imageCount, videoCount, audioCount, totalCount }` |
| `ui/src/utils/stepSuggestion.ts` | Heuristics table keyed by arch + `suggestSteps()` formula |
| `ui/src/components/StepSuggestion.tsx` | Debounced count fetch, suggestion line + Apply button |

Upstream edit: mount `<StepSuggestion/>` under the Steps `NumberInput` in
`ui/src/app/jobs/new/SimpleJob.tsx`.

Formula (all constants tunable in `stepSuggestion.ts`):

```
items     = Σ per-dataset (fileCount × num_repeats)
suggested = clamp(round(items × stepsPerImage(arch) / (batch_size × gradient_accumulation)),
                  minSteps(arch), maxSteps(arch))
range     = ±30% (clamped)
epochsEq  = suggested × batch × gradAccum / items
```

Starting values: `sdxl` (covers IllustriousXL/Pony) 100 steps/img clamp 1200–4000;
`sd15` 100, 1000–3000; `flux`/`flex*`/`chroma` 60, 1000–3000; default 75, 1000–3000.
The UI shows the math so the user can sanity-check, plus the epochs-equivalent since that is
the mental model from other trainers (kohya-style repeats/epochs do not exist here).

## Verification checklist (Phase 1)

- Save a preset → file appears in `presets/`; load into a fresh form → name/datasets
  preserved, recipe applied.
- Drop a YAML from `config/examples/` into `presets/` → lists and loads (migration applied).
- Select dataset + SDXL arch → suggestion appears with correct count (nested subfolders
  counted, `_controls` excluded); Apply sets Steps; changing batch size updates suggestion.
- Create and start a real job after loading a preset → `.job_config.json` well-formed,
  `run.py` launches.
- `git diff upstream/main --stat` → only the two upstream files show small diffs.

---

# Phase 2: Dataset Analyzer + Per-Arch Training Advisor

Ported from Anima-TrainFlow (`analyze_and_configure`, exposures gauge, bucket-vs-batch
check, per-optimizer LR table), generalized from a single hardcoded model (Anima 2B) to
ai-toolkit's arch registry (SDXL/IllustriousXL/Pony, SD 1.5, FLUX, Krea 2, Z-Image,
Qwen-Image, …).

## What Anima-TrainFlow proved out (source features)

| Anima-TrainFlow feature | Generalization here |
|---|---|
| Exposures/image gauge: `steps × batch × grad_accum / images` with ❄️/✅/🔥/💀 bands calibrated for Anima 2B | Bands derived per-arch from the existing `stepsPerItem` heuristic (healthy ≈ 0.7–1.3× the arch's steps/item; warm to 1.7×; fry beyond) |
| Bucket-vs-batch warning: buckets thinner than the batch size undertrain silently | Same check, but using an exact TS port of `toolkit/buckets.py::get_bucket_for_image_size` (divisibility = `bucket_tolerance`, default 64) so the UI predicts the trainer's real buckets, per selected training resolution |
| Resolution analysis: suggest base/max resolution from source image sizes | Advises which of the UI's resolution checkboxes make sense: flags resolutions where most source images would need upscaling |
| Auto-LR table (optimizer × batch) + Prodigy pinning | Per-arch recipe table: recommended optimizer, LR, rank, batch, resolution + one-line rationale, with Apply buttons |
| One-click "Analyze & Configure" | One "Analyze dataset" action in the advisor panel that runs count + dimension scan + all checks |
| Missing-caption pre-flight | Caption coverage reported in the same scan (count of images without a matching caption file) |

Not ported: smart crop / auto-tagging (heavy model dependencies, out of scope for this
fork), caption editor (ai-toolkit's dataset page already edits captions), A/B gallery
(ai-toolkit's job page already shows samples grouped by step).

## Design

Everything lives in fork-only files. The advisor UI expands the already-mounted
`<StepSuggestion/>` component, so the upstream merge surface stays exactly as it is
(two 1–2 line insertions; see `FORK_NOTES.md`).

New/changed fork files:

| File | Purpose |
|---|---|
| `ui/src/utils/buckets.ts` | New. Line-for-line TS port of `toolkit/buckets.py::get_bucket_for_image_size` |
| `ui/src/server/imageSize.ts` | New. Dependency-free image dimension reader from file headers (PNG/JPEG/WebP — same whitelist as `datasetFiles.ts`) |
| `ui/src/server/datasetFiles.ts` | Extend. `analyzeDatasetImages(dir)` — walks like `countDatasetFiles`, returns a `"WxH" → count` dimension histogram + caption coverage |
| `ui/src/app/api/datasets/analyze/route.ts` | New. `POST { datasetName }` → `{ imageCount, dimensionCounts, missingCaptions, unreadable }` |
| `ui/src/utils/stepSuggestion.ts` | Extend. Adds `ArchRecipe` table (optimizer/LR/rank/batch/resolution + notes per arch), `exposureGauge()` (per-arch bands), `analyzeBuckets()` (bucket distribution + thin-bucket warnings from the histogram, client-side so it reacts to batch/resolution changes without refetching) |
| `ui/src/components/StepSuggestion.tsx` | Extend. Existing step line stays; adds an "Analyze dataset" expander with the gauge, bucket table + warnings, resolution advice, caption coverage, and the arch recipe with Apply buttons |
| `presets/sdxl_character_lora.json`, `presets/sdxl_style_lora.json`, `presets/krea2_lora_low_vram.json` | New starter presets alongside the existing IllustriousXL/FLUX ones |

Data flow: the analyze API does only I/O (count + dimensions + caption files) and is cached
per dataset like the count API. All interpretation (bucketing per selected resolution,
thin-bucket check against batch size, exposure bands, recipes) happens client-side in
`stepSuggestion.ts`, so tweaking batch/resolution/steps updates the advice live.

## Per-arch recipes (initial values — tunable, advisory only)

Exposure bands come from `stepsPerItem` (already per-arch): healthy = 0.7–1.3×,
warm ≤ 1.7×, fry-risk beyond; cool below 0.7×.

| Arch (prefix) | Optimizer | LR | Rank | Batch | Resolution | Notes |
|---|---|---|---|---|---|---|
| `sdxl` (IllustriousXL, Pony, base SDXL) | adamw8bit | 1e-4 | 32 | 4 | 1024 | Booru tag captions for Illustrious/Pony; trigger tag first. LR 5e-5 for small character sets |
| `sd15` | adamw8bit | 1e-4 | 16 | 4 | 512–768 | |
| `flux` / `flex` / `chroma` | adamw8bit | 1e-4 | 16–32 | 1 | 1024 | Natural-language captions |
| `krea2` (raw/turbo) | adamw8bit | 1e-4 | 32 | 1 | 1024 | Turbo needs the training adapter (arch default sets it); low_vram default on |
| `zimage` | adamw8bit | 1e-4 | 32 | 1 | 1024 | |
| `qwen_image` | adamw8bit | 1e-4 | 32 | 1 | 1024 | |

Prodigy is not in the recipe table: ai-toolkit's optimizer list is adamw-centric and its
`automagic` optimizer already covers "don't want to pick an LR" — the recipe notes mention
it where relevant instead of porting Anima's Prodigy pinning.

## Verification checklist (Phase 2)

- `npx tsc --noEmit` and `npm run build` in `ui/` pass.
- Analyze a real dataset folder: image count matches, dimension histogram sane, missing
  captions reported.
- Bucket prediction: for a known image size + resolution 1024 + tolerance 64, TS
  `getBucketForImageSize` returns the same bucket as `toolkit/buckets.py` (spot-check via
  python one-liner).
- Thin-bucket warning appears when batch > images in a bucket, disappears at batch 1.
- Gauge bands move when steps/batch change; Apply buttons write the right config paths.
- New presets load through the Preset modal and produce a well-formed job config.
- `git diff upstream/main --stat` still shows only the two Phase 1 upstream files.

---

# Phase 3: Research-backed recipes (dataset-size scaling + scheduler)

The Phase 2 recipe table above (one fixed LR/rank/batch per arch, no scheduler field at
all) was pure guesswork carried over from Anima-TrainFlow's single-model defaults. This
phase replaced it after actually researching current (2025-2026) community/official
training guides per arch, via multiple parallel research agents. See conversation history
around 2026-07-12 for full per-source findings and confidence levels; the summary below is
what actually changed in code.

## What changed in `ui/src/utils/stepSuggestion.ts`

1. **`ARCH_RECIPES` is now keyed by dataset-size tier**, not a single fixed recipe per arch.
   `getSizeTier(itemCount)` buckets into `small` (<30 images) / `medium` (<150) / `large`
   (150+), matching the "small sets overfit at high rank/LR, large sets tolerate more
   capacity" pattern that recurred across every researched guide. `getArchRecipe(arch,
   itemCount, modelPath)` takes the already-computed `itemCount` and returns
   tier-appropriate rank/alpha/LR.
2. **Illustrious-XL and Pony Diffusion are detected from `model.name_or_path`**, not arch —
   both are SDXL-architecture checkpoints (`model.arch: "sdxl"`), so there's no arch key to
   distinguish them. `illustriousOrPonyRecipe()` pattern-matches the checkpoint path
   (`illustrious`, `pony` substrings) and returns a distinct recipe:
   - Illustrious: adamw8bit + **constant** scheduler, rank 64/alpha 32 (large sets), booru
     captions. The optimizer choice is genuinely contested in the source guides (one camp
     found Prodigy works poorly on Illustrious, another still prefers Prodigy+cosine) —
     constant was chosen as the documented safer default, not because consensus settled it.
   - Pony: adamw8bit + cosine, rank 32/alpha 16 (most-repeated but not universal), booru/e621
     captions. The `score_9`/`score_8_up` quality-tag convention is explicitly contested —
     notes warn against blindly including `score_9` on mixed-quality training images.
   - Vanilla SDXL (no name match) keeps its own separate, more conservative recipe.
3. **Added an `lr_scheduler` suggestion** — this trainer had *zero* UI exposure for LR
   scheduler anywhere before this change (`toolkit/config_modules.py` silently defaults to
   `'constant'` if the config never sets it). Recipes now suggest cosine for
   SDXL-family/SD1.5, constant for the Flux family — this is architecture-dependent per the
   research, not a single global default.
4. **Added `flux2_klein_4b`/`flux2_klein_9b` recipes** (ai-toolkit already has native model
   support for these arches). Explicitly flagged in the notes as unverified FLUX.1-proxy
   numbers, since essentially no FLUX.2-specific tuning literature exists yet as of this
   writing.
5. **Krea 2's recipe is unchanged in substance** (research found the existing numbers were
   already consistent with the thin evidence base available — the model is ~6 weeks old),
   but the notes now say explicitly that no source states a scheduler recommendation for it,
   rather than silently reusing a scheduler default that isn't backed by anything.

## Research confidence, condensed

- **High confidence / consensus**: SDXL/Illustrious/Pony resolution (1024), booru vs
  natural-language caption split by checkpoint family, cosine-vs-constant scheduler split
  between SDXL-family and Flux-family, "small dataset → lower rank/LR" direction (though not
  the exact numbers).
- **Genuinely contested, not resolved by this change**: exact SDXL-family rank (guides range
  8-128), Illustrious optimizer (Prodigy vs AdamW8bit), whether Pony captions should include
  `score_9`.
- **Thin/no evidence, flagged rather than guessed**: Krea 2 scheduler, any Flux2/Flux2-Klein-
  specific numbers (proxied from FLUX.1 instead), Qwen-Image/Z-Image scheduler.

## Verification checklist (Phase 3)

- `npx tsc --noEmit` passes for `ui/src/utils/stepSuggestion.ts` and
  `ui/src/components/StepSuggestion.tsx` (pre-existing `.next/types` route-param errors
  elsewhere in the repo are unrelated staleness, not caused by this change).
- Select a checkpoint with "illustrious" or "pony" in `model.name_or_path` under an `sdxl`
  arch → advisor shows the checkpoint-specific recipe, not the vanilla-SDXL one.
- Change dataset size across the 30/150 item thresholds → rank/alpha/LR in the Apply buttons
  change accordingly.
- Apply the scheduler button → `config.process[0].train.lr_scheduler` appears in the
  generated job config (verify in the actual `.job_config.json`, since the UI's `TrainConfig`
  type doesn't declare this field — `setJobConfig` sets it as a plain dot-path regardless).

# Phase 4: Anima 2B architecture port (Workstream A2 of ANIMA_INTEGRATION_SPEC.md)

Recon (A1) and design history live in `docs/anima_delta_catalog.md` — read it before
touching anything Anima. Summary of what Phase 4 added:

- `extensions_built_in/diffusion_models/anima/` — fork-only model extension:
  - `src/anima_transformer.py`: vendored Cosmos-Predict2 MiniTrainDIT + LLM adapter,
    ported byte-identical (per-class AST diff) from kohya sd-scripts v0.10.5
    (`library/anima_models.py`), with sd-scripts-only infra (block swap, unsloth
    offload, fp8 hooks, custom attention dispatch) removed. Plain SDPA attention
    (bit-exact to the source's attn_mode="torch" path). `rebuild_buffers()` exists
    because the model is constructed on the meta device and RoPE tables are not
    stored in checkpoints.
  - `anima_model.py`: AnimaModel (arch "anima"). Dual tokenization (Qwen3 + T5 @512,
    the T5 ids are adapter query tokens, never encoded), Qwen3 last_hidden_state
    zeroed at padding, VAE = diffusers AutoencoderKLQwenImage with per-channel
    mean/std and deterministic mode() (parity: do NOT change to sample()),
    rectified-flow target noise−latents, t = timestep/1000. LoRA export/load remaps
    toolkit PEFT keys to kohya sd-scripts keys (`lora_unet_*` + synthesized alpha ==
    rank, since toolkit PEFT LoRA trains at scale 1.0) — this is spec hard gate A3;
    foreign alphas are folded into lora_up on load.
  - `AnimaFlowMatchScheduler`: adds `model_kwargs.sigmoid_scale` (author trains 1.3)
    to the sigmoid timestep sampler.
- Registered in `extensions_built_in/diffusion_models/__init__.py` (upstream file,
  +1 import +1 list entry — recorded in FORK_NOTES.md).
- UI arch entry appended last in `ui/src/app/jobs/new/options.ts` (upstream file);
  recipe added to ARCH_RECIPES in `ui/src/utils/stepSuggestion.ts` (fork file). The
  Anima recipe is the model author's own published numbers (rank 32, adamw 2e-5,
  batch 1 + accum 4, adapter frozen) — highest confidence of any arch.
- `config/examples/train_lora_anima_2b.yaml`, `presets/anima_lora_performance.json`,
  `presets/anima_lora_background.json` (background = author's config + low_vram,
  default for shared-GPU use per spec Workstream C).
- Default LoRA targeting mirrors sd-scripts: target class `Block` only + configs set
  `network_kwargs.ignore_if_contains: ["adaln_modulation"]`. The LLM adapter is never
  LoRA-targeted (author: easy to degrade).

## Verification checklist (Phase 4)

- [x] Smoke test (scratchpad, bare torch): meta-load + rebuild_buffers, forward fwd/bwd
      with grad checkpointing, config auto-detect, LoRA key round-trip incl. alpha.
- [x] A2 gate: end-to-end LoRA run on `anima_sample_training/` completes
      (2026-07-12: `config/train_anima_a2_smoke.yaml` — 20 steps, batch 1, 512,
      `output/anima_a2_smoke/anima_a2_smoke.safetensors` with sd-scripts
      `lora_unet_*` keys + alpha). Runtime fixes landed with the gate:
      preview autocast in `src/pipeline.py`, bf16 timestep/AdaLN dtype casts in
      `anima_transformer.py`, force Long for T5/Qwen3 ids+masks in
      `anima_model.get_noise_prediction` (cache path was promoting them to bf16).
- [ ] A3 HARD GATE: `scripts/dump_lora_keys.py` zero-diff vs a TrainFlow-produced LoRA
      + user confirms ComfyUI/SwarmUI load.
- [ ] A4: loss-curve/sample parity vs TrainFlow (same data/seed/hypers), Prodigy check.
- [ ] C gate: measured VRAM under target in a live background-preset run.
