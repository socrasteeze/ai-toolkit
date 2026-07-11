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
