# Fork Enhancement Plan

Personal-use enhancements for this fork of [ostris/ai-toolkit](https://github.com/ostris/ai-toolkit).
This document is the design history — *why* things are the way they are, phase by phase.
`FORK_NOTES.md` tracks the actual merge surface against upstream; `CLAUDE.md` is the
entry point for a new session.

Status: **Phases 1–4 all shipped.** Phase 1: presets + step suggestion. Phase 2: dataset
analyzer + per-arch advisor. Phase 3: research-backed recipe overhaul. Phase 4: Anima 2B
port (`ANIMA_INTEGRATION_SPEC.md`, now complete — see its status banner). Nothing is
queued; this is a reference doc, not a task list.

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

## Phase 3 addendum (2026-07-19): cross-check against LoRA Dataset Studio

The sibling LDS fork ships fifteen researched built-in presets; a full cross-check
(`docs/preset_alignment_2026_07.md`, canonical copy in the LDS repo) found the two
codebases aligned on FLUX.1 (both from Ostris' canonical yaml — flux_lora_24gb.json
v1.1 restores its EMA 0.99) and Krea 2 (32/32 + linear), diverging on SDXL character
alpha (LDS 32/16 half-alpha vs our 32/32 + conv — two sourced schools, left as-is),
and complementary elsewhere. Synced ADDITIVELY from LDS: seven presets for the
families/kinds we lacked (Z-Image, FLUX.2 Klein, and the Concept kind), plus
timestep-guidance sentences in the zimage/krea2/flux2_klein advisor notes (numbers
untouched). All contested values from the list above remain contested — nothing was
quietly resolved.

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
- UI arch entry appended last in `ui/src/app/jobs/new/options.tsx` (upstream file);
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
- [x] A3 key/shape parity: `scripts/dump_lora_keys.py` reports zero mismatch vs a
      TrainFlow/sd-scripts reference LoRA (`Anima-TrainFlow/training/output/a3_ref/a3_ref.safetensors`,
      20 steps via vendored `anima_train_network.py` + `networks.lora_anima`).
      Both dumps: 840 keys. User confirmed 2026-07-12 that the toolkit-trained LoRA
      loads and applies in SwarmUI without errors — **A3 HARD GATE passed in full**.
- [x] A4: loss-curve/sample parity vs TrainFlow — PASS (2026-07-12). Matched 400-step
      AdamW runs (`a4_ref` in TrainFlow, `config/train_anima_a4_parity.yaml` here):
      loss curves statistically indistinguishable (first-half means 0.1783 vs 0.1812;
      overall gap within ~1.8σ of per-step noise), samples equivalent at 100..400.
      Prodigy: identical prodigyopt 1.1.2 class both sides; matched 100-step runs both
      adapt d off the 1e-6 floor to the same order (4.8e-6 vs 2.5e-6). Known benign
      diffs (toolkit pins eps=1e-6, lr<0.1 auto-bump, no d*lr logging, prodigyopt-vs-
      TrainFlow default args) documented in `docs/anima_a4_parity.md` (gate artifact).
- [x] C gate: measured VRAM under target in a live background-preset run — PASS
      (2026-07-12, artifact `docs/profiles.md`): 120-step run of the background
      preset settings (res [512,768,1024], batch 1 + accum 4, low_vram, 1024
      sampling), nvidia-smi every 2s: steady-state 9.9–10.7 GB (30–33% of 32GB),
      peak 14.1 GB (43%) during 1024×1024 sample gen. Target was ≤60–70%.
      The gate run also flushed out a bug: a missing sample `neg` reaches
      `get_prompt_embeds` as None/False (SampleConfig.neg defaults to False) via
      DiffusionTrainer.cache_sample_prompts — now coerced to the empty prompt in
      `anima_model.py` (matches sd-scripts' unconditional input).
- [x] B1 pre-flight validator: `scripts/preflight.py` (2026-07-12) — bare-folder or
      `--config job.yaml` mode; errors (exit 1) on missing folder/no images/corrupt
      images/missing captions/bad local model paths, warnings on oversized (≥2048px,
      non-fatal here since the toolkit buckets+downscales — deliberate departure from
      TrainFlow's hard block), empty captions, stray files; `--allow-missing-captions`
      and `--warn-only` overrides. Wiring into the UI job-launch path is deferred to
      B5 (that path is upstream code — new touchpoint needs its own decision).
- [x] B4: already reconciled — `ui/src/utils/stepSuggestion.ts` covers it (incl. the
      Anima recipe); no competing CLI built.
- [x] B2 WD14 auto-caption: `scripts/auto_caption.py` (2026-07-12, deps approved by
      user) — faithful port of TrainFlow's WDTagger (wd-eva02-large-tagger-v3, same
      preprocessing/thresholds/tag assembly incl. kaomoji + paren escaping), plus
      `--trigger-word` prepend and HF auto-download. Live-tested on sample images,
      GPU via onnxruntime-gpu + torch-bundled CUDA DLLs (os.add_dll_directory).
- [x] B3 U2Net smart prep: `scripts/smart_prep.py` (2026-07-12) — TrainFlow's
      SmartCropper (head-first saliency crop, log-AR bucket match, 64px bucket lattice)
      made non-destructive (in_dir→out_dir per spec, caption sidecars copied; TrainFlow
      mutated in place with a backup dir). u2net.onnx auto-downloads to
      `~/.cache/ai-toolkit/`. Live-tested on the 3 oversized 3840px sample images →
      correct 768x512 bucket, subject preserved. Deps in `scripts/requirements-qol.txt`
      (onnxruntime-gpu), deliberately not in upstream requirements.txt.
- [x] B5 UI "Dataset Tools" panel (2026-07-12): `DatasetTools.tsx` (TopBar button +
      modal on the dataset page) → fork-only `api/datasets/tools` route →
      `server/datasetTools.ts` child-process runner (reuses upstream's
      `cron/pythonPath.ts`; in-memory run registry, NOT a Prisma job — fork rule 2).
      One new upstream touchpoint: the JSX mount in `datasets/[datasetName]/page.tsx`
      (5th upstream-modified file, listed in FORK_NOTES). **Decision: pre-flight is
      advisory-only** — a hard submission block would need an insertion in upstream's
      `api/jobs/[jobID]/start/route.ts` + its caller; the advisory button gets ~90% of
      the value with zero extra upstream surface. Upstream's own Auto Caption (VLM,
      Prisma-job-based) coexists: the WD14 tagger covers the booru-tag use case.
      Verified: tsc clean, live API run of preflight against a real dataset via dev
      server (spawn → log stream → exit code all correct).

## Upstream Anima collision → fork port SUNSET (2026-07-16)

Upstream landed its own Anima support (ostris#860 + a sampling-bar fix) the day after
this phase completed: a diffusers-based implementation (`CosmosTransformer3DModel` via a
pinned diffusers commit) in the SAME directory (`extensions_built_in/diffusion_models/
anima/anima.py`) with the SAME `arch = "anima"` key and its own diffusers→comfy LoRA key
conversion. The initial merge that day kept the fork's port, but the user reversed that
the same day: **Decision (user, 2026-07-16, final): sunset the fork's port and adopt
upstream's implementation wholesale** — `extensions_built_in/diffusion_models/anima/`,
`diffusion_models/__init__.py`, and `options.tsx` are byte-identical to upstream again,
and the vendored sd-scripts transformer (`anima_model.py`, `src/`) is deleted. The
Phase 4 gate artifacts (`docs/anima_delta_catalog.md`, `docs/anima_a4_parity.md`,
`docs/profiles.md`, `ANIMA_INTEGRATION_SPEC.md`) remain as historical record of the
retired port.

The fork's Anima *enhancements* were ported onto upstream's implementation:

- `presets/anima_lora_{performance,background}.json` (v2.0) and
  `config/examples/train_lora_anima_2b.yaml` now target
  `circlestone-labs/Anima-Base-v1.0-Diffusers` and express the author's
  "Block-only" LoRA targeting via `ignore_if_contains` with upstream's DIFFUSERS
  module names (`norm1.linear`, `norm2.linear`, `norm3.linear`, `norm_out.linear`,
  `patch_embed`, `time_embed`, `proj_out`) instead of sd-scripts'
  `adaln_modulation`. Without this list, upstream LoRA-targets every linear in
  `CosmosTransformer3DModel`, including the AdaLN modulation linears the author
  excludes.
- **Lost in translation:** the author's `sigmoid_scale: 1.3` timestep widening has
  no equivalent in upstream's implementation (its `model_kwargs` only support
  `train_text_conditioner` and `max_sequence_length`); presets fall back to plain
  `timestep_type: sigmoid` and say so in their descriptions. If upstream ever adds
  a timestep-scale knob, wire it back in.
- The advisor recipe in `stepSuggestion.ts` (`ARCH_RECIPES.anima`) was already
  implementation-agnostic (lr/rank/alpha/batch/accum numbers) and is unchanged.
- The LLM adapter stays frozen by default in upstream's implementation too
  (`train_text_conditioner` defaults to false) — the author's instruction holds.
- Existing sd-scripts-format LoRAs still LOAD for resume/continue: upstream's
  `convert_lora_weights_before_load` routes `diffusion_model.*` keys through
  diffusers' `_convert_non_diffusers_anima_lora_to_diffusers`. New exports use
  upstream's comfy-style key conversion (which, unlike the retired port, CAN emit
  `adaln_modulation`/`final_layer`/embedder keys if the ignore list is dropped).
- Upstream's Anima requires the diffusers commit pinned in `requirements_base.txt`
  (c9438378...) — re-run `pip install -r requirements.txt` in the training venv
  before the first post-sunset Anima run.

## Fix: WORKER process crash on job-launch errors (2026-07-17)

**Symptom (user report):** after a training job completed, the cmd window running
`start.bat` (i.e. `npm run start`, which runs `concurrently ... "node dist/cron/worker.js"
"next start --port 8675"`) printed something about a process being closed/no longer
running, then the window stopped responding entirely.

**Investigation:** the terminal-emulator/logging rework merged from upstream earlier the
same session (`toolkit/print.py`, `ui/src/utils/terminalEmulator.ts`, `useJobLog.tsx`,
`log/route.ts`) was the first suspect given the timing, but all of that code runs either
in the Python process's own stdout/log file or in the browser (client component) — none
of it runs in the Node processes `concurrently` supervises, so a bug there can't crash
"the server." Traced the actual crash surface instead:

- `ui/cron/actions/startJob.ts`'s `startAndWatchJob(job)` is called **fire-and-forget**
  from `startJob()` — intentionally not awaited, so the 1-second `processQueue()` cron
  tick isn't blocked by a job's file I/O/DB writes while spawning it. But the function
  body wraps its work in `new Promise<void>(async (resolve, reject) => {...})` — the
  "async executor" antipattern. Only the block around `spawn()` actually calls
  `reject`/marks the job `status: 'error'`; several earlier `await`s
  (`getTrainingFolder()`, `getHFToken()` — both Prisma reads) and synchronous calls
  (`fs.mkdirSync`, `fs.writeFileSync`) are **unprotected**. If any of them throws, the
  async executor's own promise rejects with nothing listening to it — `resolve`/`reject`
  are never called, so the *outer* Promise `startAndWatchJob()` returns just hangs
  forever, AND the throw becomes a genuine Node **unhandled promise rejection** that
  bypasses every try/catch elsewhere in the codebase (including `worker.ts`'s
  `run()`, which only wraps the *awaited* part of `processQueue()` — this fire-and-forget
  branch has already returned by the time the rejection happens).
- Node 15+ terminates the process by default on an unhandled rejection. `concurrently`'s
  `start` script runs with `--restart-tries -1 --restart-after 1000`, so a WORKER crash
  respawns it after 1s — logged as `"node dist/cron/worker.js" exited with code 1`
  (the "process is closed/no longer running" text). One isolated crash+restart is
  mostly self-healing (a stray `SQLITE_BUSY` from the Prisma read racing one of Python's
  frequent raw-`sqlite3` `BEGIN IMMEDIATE` status/step writes in
  `extensions_built_in/sd_trainer/UITrainer.py` — every training step writes to the same
  `aitk_db.db` file `getTrainingFolder()`/`getHFToken()` read from). But with a
  **multi-job queue**, each subsequent queued job re-triggers the same unprotected path
  when its turn comes up; if the trigger condition persists (e.g. the disk filled up
  from the training run that just finished, so `fs.mkdirSync`/`fs.writeFileSync` for the
  *next* job keeps throwing `ENOSPC`), WORKER crashes and restarts every ~1s for as long
  as queued jobs remain — indistinguishable from a frozen console (rapid repeating
  output, and Ctrl+C has to interrupt a process that keeps respawning). This matches
  "right after training completed" (the queue advances to the next job, or the disk is
  now full from the job that just finished) and "the cmd froze" (the crash-restart
  cycle). Confirmed this is a live bug class upstream is actively chasing too — commit
  `741aeb9` ("Clear stale return-to-queue flag when starting jobs, fixes crash loop
  (#920)", 2026-07-15, already in this repo) fixed a *different* variant of the same
  "job launch throws → WORKER crash-loops" family in the same file.

**Fix:**
1. `ui/cron/actions/startJob.ts` — replace the async-executor `new Promise` with a plain
   `async function startAndWatchJob`, with the entire body wrapped in one try/catch that
   marks the job `status: 'error'` (best-effort, itself guarded so a failing DB write
   can't throw a second time) and returns normally either way. `startJob()` now calls
   `startAndWatchJob(job).catch(...)` explicitly so even a defect in the new catch block
   can never become an unhandled rejection again.
2. `ui/cron/worker.ts` — added `process.on('unhandledRejection', ...)` and
   `process.on('uncaughtException', ...)` top-level handlers that log and keep the
   process alive. This is deliberately a safety net, not a substitute for fix #1: it
   protects against the *next* bug in this class (upstream has shipped at least two
   variants already) without requiring another multi-hour investigation next time the
   symptom recurs.
3. Left `concurrently`'s `--restart-tries -1 --restart-after 1000` as-is — infinite
   auto-restart is the correct behavior for a background queue processor; the bug was
   that it was needed at all for routine, expected failure modes (a full disk, a busy
   SQLite file) rather than being reserved for genuinely unexpected crashes.

**Not changed:** the SQLite contention between Python's raw `sqlite3` writes and
Prisma's reads of the same `aitk_db.db` file is a real but low-frequency hazard (both
sides already use reasonable timeouts/autocommit); revisit only if `SQLITE_BUSY` shows
up repeatedly in the WORKER log now that it's visible instead of crashing silently.

**Verified (2026-07-17):** `tsc --noEmit` clean, `tsc -p tsconfig.worker.json` clean.
Ran the compiled `dist/cron/worker.js` standalone and injected a genuine unhandled
promise rejection (`Promise.reject(new Error(...))`, the same failure class the old
code would have produced) — confirmed the process logs it via the new handler and
keeps running past it, where the pre-fix code would have terminated immediately. Also
confirmed 12s of normal 1-second cron ticks with no errors (no regression to the
success path). Full multi-minute GPU training run not exercised as part of this fix —
the change is confined to error-handling around job launch, not the training path
itself.

## Phase 5: advisor KREA2 calibration + recipe-button feedback (2026-07-17)

Two related advisor tweaks after a user's live KREA2 training session.

**KREA2 step heuristic.** `ARCH_HEURISTICS` had no `krea2` entry, so the exposure gauge
fell back to the generic 75-steps/item default and flagged a 266-image run at 3000 steps
× batch 4 (45 exposures/image) as "cool — likely undertrained." Research (see the four
sources logged in the session: musubi-tuner 12GB guide, RunComfy Krea2-Turbo, the
JahJedi/krea2-character-lora-recipe HF doc, Krea's own blog) shows the community splits
by dataset size: small sets (~20-40 img) use 600 steps as a viable floor and ~2000 as
the preferred "safe" number (~60-100 exposures), while large published recipes (127-474
img) converge at only ~15-20 exposures. Added `krea2: { stepsPerItem: 65, minSteps: 600,
maxSteps: 4000 }`, calibrated to the small-dataset consensus (600 = cool/floor, 2000 =
healthy). **Documented limitation** (in the code comment): like every fixed steps/item
target here, it over-warns on large datasets — a 250+ image set reading "cool" at 3000+
steps is usually already fine; trust the sample grids over the gauge. A proper fix would
make the exposure target dataset-size-aware (required exposures scale inversely with
dataset size), which is a larger change to shared gauge logic deferred for now. The
number is community-derived guesswork, flagged as such in the notes per the honesty rule.

**Recipe-button feedback.** User reported the suggestion/recipe buttons "didn't seem to
apply — no visible change." Root cause: they *were* applying, but the user's config
already matched most recipe values (rank 32 / alpha 32 / LR 1e-4 all equal to the krea2
recipe), so the writes were no-ops with no visual signal — and two recipe buttons
(`alpha` → `network.linear_alpha`, which shares the single "Linear Rank" field, and
`scheduler` → `train.lr_scheduler`, which has no UI field anywhere) write to config keys
the form doesn't display, so they *never* show a visible change regardless. Fix (all in
the fork-only `ui/src/components/StepSuggestion.tsx` — no upstream touchpoint): each
recipe button now reads the current config value at its path (local `getAtPath` helper,
mirroring `setNestedValue` rather than exporting a new symbol from upstream's
`hooks.tsx`) and renders state-aware — a green `✓ label` when already set, or `label
(now <current>)` in blue when it would change. Clicking a differing button flips it to ✓
immediately, giving feedback even for the invisible-field buttons. "Apply all" shows
`✓ All applied` when everything matches, and the step "Apply" shows `✓ set` instead of
vanishing when steps already equal the suggestion. Verified: tsc clean on both changed
files, no new upstream file touched (`git diff upstream/main` surface unchanged), and a
logic test against the user's exact config confirmed 3 buttons read ✓ and only `batch`
shows as an available change.

## stop.bat killswitch (2026-07-18)

Companion to `start.bat`. After a run finished overnight, the user focused the terminal
and it "froze" — this is Windows **QuickEdit Mode**: clicking into a console window enters
text-selection mode and pauses the program's stdout until a keypress/right-click. It is
not a crash (the server keeps running), but the user closed the window, which orphaned the
two `concurrently`-supervised node processes (Next.js UI on 8675 + `dist/cron/worker.js`
worker) — they kept running headless and holding port 8675, which would make the next
`start.bat` fail with the same `EADDRINUSE` restart-loop seen on 2026-07-17.

`stop.bat` (fork-only, root, double-click or `stop.bat` from a shell) finds and kills those
two by **command-line signature** — the UI by `--port 8675`, the worker by
`cron[\/]worker.js`, plus any `concurrently` supervisor referencing the port, plus whatever
currently listens on 8675 — via an inline PowerShell one-liner (`Get-CimInstance
Win32_Process` + `Stop-Process -Force`). Signature-matching is deliberate so it never kills
unrelated node apps. Tree-kill isn't needed: once orphaned these are leaf processes.
Detached training (`run.py`, a separate process that intentionally survives the server) is
left alone by default; `stop.bat all` additionally stops a running `run.py` (with a
progress-loss warning). Verified live: ran the kill logic against the actual orphaned
PIDs (UI 99728 + worker 98996), both stopped, port 8675 confirmed free afterward.

QuickEdit itself isn't disabled by this (that's a per-console/registry setting); the
offer to disable it stands, but `stop.bat` makes the frozen-terminal case recoverable
regardless.

## Dataset folder browser: nested subfolder selection (2026-07-19)

**Problem (user report):** the "Target Dataset" field only lists top-level folders under
the datasets root (`ui/src/app/api/datasets/list/route.ts` does one non-recursive
`readdir` of the root). There was no way to target a nested folder like
`Dataset/Folder 1/Folder 1a` — it never appeared as an option. Meanwhile the trainer
(`toolkit/data_loader.py`, upstream, unmodified) walks whatever `folder_path` you give it
fully recursively (`os.walk`), so selecting "Folder 1" silently trained on every image in
every descendant subfolder too. The fix isn't to change the trainer's recursion (that's
correct, expected behavior other configs rely on, and it's upstream-owned code) — it's to
let the user navigate down and pick the exact folder they mean, so the existing recursive
walk starts from the right place.

**What shipped**, entirely fork-only except one small `SimpleJob.tsx` addition:

- `ui/src/app/api/datasets/browse/route.ts` (new) — POST `{datasetName, subPath}`,
  returns `{breadcrumbs, folders}` for one level (non-recursive `readdir`, mirrors
  `list/route.ts`'s dotfile-skip + isDirectory filter, plus skips `_controls`). Each
  navigation step is one shallow listing, so it stays fast at any depth.
- `ui/src/components/DatasetFolderPickerModal.tsx` (new) — breadcrumb-navigable modal,
  global-state (`createGlobalState` + `openDatasetFolderPicker(...)`), mirroring
  `AddSingleImageModal.tsx`'s exact open/mount convention so it needs only one mount
  point and no prop-drilling. Opens at whichever subfolder the field is currently
  pointed at (not always back at the top), breadcrumbs let you jump back up any number
  of levels, clicking a folder descends, "Select this folder" applies wherever you've
  navigated to (not just leaves).
- `SimpleJob.tsx` — one small addition under the existing "Target Dataset" `SelectInput`:
  a text line showing the actual resolved current path, plus a "Browse subfolders…"
  button. The existing flat dropdown is untouched (still the fast top-level picker).
  The text line exists because of a real gotcha: `SelectInput` derives its displayed
  value by matching `folder_path` against its flat `options` list — a nested path won't
  match anything, so the dropdown would silently show blank even though the value is
  set correctly. `datasetName`/`subPath` for the button are derived purely from
  `datasetOptions` + the current `folder_path` (find the option whose value prefixes
  `folder_path`, subtract it) — no new prop needed, no dependency on knowing
  `DATASETS_FOLDER` directly in this file.

**Security finding during live verification:** the plan's verification step (curl the
new route with a `../` traversal payload) caught a real bug — not in the new route
itself, but a *pre-existing* one in this pattern. `datasetName: ".."` successfully
listed the parent of the datasets root. Root cause: `path.basename('..')` returns `'..'`
unchanged (it only strips leading directory components, it doesn't resolve relative
segments), so `path.join(datasetsRoot, path.basename(datasetName))` doesn't stop a bare
`".."` or `"."` value at all. This exact pattern was already shipped in two existing
fork routes (`count/route.ts`, `analyze/route.ts`) — copied from one to the other
originally, so the same flaw existed in both, silently, since whichever commit added
the first one. Multi-segment payloads like `"../../etc"` were incidentally safe (basename
reduces them to just `"etc"`, a literal folder name that plausibly doesn't exist) — only
the exact strings `".."` and `"."` passed through unsafely.

Fixed with a shared `sanitizeDatasetName(name)` helper added to `datasetFiles.ts`
(rejects any name containing `/`, `\`, or equal to `"."`/`".."`) and adopted by all three
routes (`browse`, `count`, `analyze`) — a single source of truth instead of duplicating
the check three times, so a future fourth `datasetName`-accepting route has an obvious
function to reach for.

**Verification performed:**
- `tsc --noEmit` clean on every new/changed file, before and after the security fix.
- Confirmed `Folder`/`Loader2`/`ChevronRight` are real `lucide-react` exports by grepping
  its type declarations directly (an ad hoc `node -e require('lucide-react')` check
  falsely suggested they were undefined — a CJS/ESM interop artifact of probing an
  ESM-only package directly with `require()`, not a real problem; tsc's check against
  the actual `.d.ts` files is the reliable signal here).
- Live end-to-end test: launched a throwaway `next dev` on a scratch port against a real
  dataset with real subfolders (`automatic_giraffe/{cache_text_encoder,latent_cache,
  original_images}` under the machine's actual configured `DATASETS_FOLDER`), curled the
  new route for the dataset root (correct 3-folder listing) and for a descended
  subfolder (correct breadcrumbs, correct empty-folder-list leaf response).
- Curled all three routes with `datasetName: ".."` and `"."` before the fix (root escape
  confirmed on `browse`) and after the fix (all three correctly return 400), plus
  confirmed the legitimate case still works post-fix.
- Confirmed the upstream diff surface after the change contains exactly one upstream
  file (`SimpleJob.tsx`) plus the new/changed fork-only files — nothing unexpected.
- Reverted an unrelated `ui/package-lock.json` diff that `npx` commands touched as a
  side effect (npm-version metadata churn, not a real dependency change) before
  committing, to keep the change scoped to the feature.

## Dataset folder scope: loose files and selected child folders (2026-08-12)

The nested-folder browser originally chose only a recursive starting point. Selecting a
parent still meant every loose file and every descendant trained together, with no way to
keep the parent as the visible dataset while excluding loose files or sibling folders.

Each dataset config now carries two backward-compatible scope keys:

- `include_loose_files` (default `true`) controls media directly inside `folder_path`.
- `include_subfolders` (default `null`) controls immediate child folders. `null` means all
  children, a list selects only those named children, and `[]` selects none. Every selected
  child is recursive, so choosing `Folder A` includes its full subtree.

The folder modal exposes the same contract. Turning off "Include every child folder"
reveals checkboxes for the current folder's immediate children. Navigating into `Folder A`
and selecting it changes `folder_path` to `Folder A`; parent loose files and sibling folders
are therefore outside the trainer's walk regardless of the child scope.

Trainer enumeration lives in fork-only `toolkit/dataset_selection.py`, called by the small
`toolkit/data_loader.py` insertion. The UI's count/analyze routes use the equivalent
fork-only `ui/src/server/datasetScope.ts` traversal so step suggestions, exposure counts,
bucket analysis, and caption coverage measure exactly what will train. Scope values are
part of the advisor cache key; two rows pointing at the same path with different filters
cannot share a stale count.

Regression coverage locks the contract on both sides: root loose-only, loose exclusion,
one selected child with recursive descendants, legacy all-content behavior, nested-folder
isolation, hidden/`_controls` exclusion, duplicate normalization, and unsafe child-name
rejection.

## Fix: step suggestion disappeared for nested subfolder selections (2026-07-19)

**Regression from the folder browser feature above.** Selecting a nested folder via the
new "Browse subfolders…" modal made the step-suggestion panel vanish entirely, instead
of just failing to show a number.

**Root cause:** `StepSuggestion.tsx`'s `folderPathToDatasetName` derived the dataset name
to query by taking the *last* path segment of `folder_path` — correct for a top-level
selection (`.../automatic_giraffe` → `automatic_giraffe`, matching the actual top-level
dataset name), but wrong for a nested one (`.../automatic_giraffe/original_images` →
`original_images`, which isn't a real top-level dataset). The count API 404'd, `fetchCount`
caught it and returned -1, `itemCount` fell to 0, and `suggestSteps` returns `null` on
zero items — which the component treats as "render nothing at all."

A second issue would have surfaced immediately after fixing the first: `/api/datasets/count`
and `/api/datasets/analyze` always counted the *entire* top-level dataset recursively,
with no way to scope to a subfolder — so even with the right dataset name, a nested
selection would report an inflated count (the whole dataset's files, not just the
selected subfolder's), rather than what the trainer will actually walk.

**Fix, both parts:**
1. `count/route.ts` and `analyze/route.ts` now accept an optional `subPath` (same shape
   as the `browse` route), resolved via a new shared `resolveDatasetSubPath(datasetRoot,
   subPath)` helper in `datasetFiles.ts` — the same segment-filtering + traversal-guard
   logic `browse/route.ts` already had, now deduplicated into one place all three routes
   use (`browse/route.ts` was refactored to call it too, replacing its inline copy).
2. `StepSuggestion.tsx`'s `folderPathToDatasetName` was replaced with
   `deriveDatasetSelection(folderPath, datasetsRoot)`, which needs to know the actual
   datasets root to split `folder_path` correctly (first segment after the root =
   datasetName, everything after = subPath) — added a `useSettings()` call to get
   `DATASETS_FOLDER` (the same hook `page.tsx` already uses to build `datasetOptions`).
   Every downstream reference (`datasetInputs`, `counts`, `analyses`, `merged`, the
   fetch functions and their caches) was switched from keying on the bare dataset name
   to a combined `datasetName` or `datasetName::subPath` key, so two dataset rows
   pointing at different subfolders of the same top-level dataset get independent counts
   instead of colliding.

**Verification:**
- `tsc --noEmit` clean.
- Live-tested `count`/`analyze` against the machine's real (and, since the last session,
  *changed* — `DATASETS_FOLDER` moved up one level, off the per-style subfolder onto the
  datasets root itself) configured datasets root, three levels deep: root count 2176, one level down
  (`automatic_giraffe`) 339, two levels down (`automatic_giraffe/original_images`) 171 —
  confirming `subPath` genuinely scopes the count rather than always returning the full
  recursive figure. Re-confirmed the traversal guard still rejects `../` payloads on the
  now-subPath-aware `count` route too.
- Verified `deriveDatasetSelection`'s client-side logic in isolation against the exact
  `folder_path` values the app would actually produce: a plain top-level selection, a
  nested one built the way `SimpleJob.tsx`'s browse-modal callback constructs it
  (`/`-joined), a doubly-nested one, a Windows-backslash path (e.g. from an imported
  config), an empty/default path, and a path outside the datasets root — all matched the
  live API results exactly, and the unrelated-root/default cases correctly return `null`
  (no query fired) rather than a false match.
- Testing this required a `next dev` instance again, which — as documented in the
  stop.bat/EADDRINUSE incident — writes to the same `.next` folder as `next start` and
  breaks the production build. This time: confirmed the user had *already restarted*
  their own production server (a different PID, started before this fix's dev-server
  test) on port 8675 before I touched `.next`; did `rm -rf .next` + a full `next build`
  + `BUILD_ID` + smoke-test verification afterward same as before; then confirmed the
  user's already-running server survived the `.next` swap without needing a restart
  (Next.js re-reads compiled routes from disk per-request rather than holding the whole
  build in memory) — both `/` and `/jobs/new` returned 200 against their live process
  after the rebuild. Flagged to the user that an already-open browser tab from before the
  rebuild may need a hard refresh to pick up new JS chunk hashes, but the server itself
  needed no restart.

  **CORRECTION (2026-07-28): the last two sentences above are wrong, and believing them
  broke the user's running UI.** Testing only top-level route HTML (`/` and `/jobs/new`
  returning 200) does not exercise the failure. A running `next start` is pinned to the
  build it launched with: it keeps serving HTML that references the OLD hashed chunk
  filenames, which `next build` has already deleted, and it returns **404 for the NEW
  chunk files even though they exist on disk**. The result is `ChunkLoadError: Loading
  chunk NNNN failed` the moment the user navigates to any route that lazy-loads a chunk
  (hit live on `/queue`). A browser hard refresh does NOT fix it, because the server
  itself is the stale side.

  **Rule: after any `next build` against a running production server, the server must be
  restarted (`stop.bat`, then relaunch).** Verify with
  `curl -s -o /dev/null -w '%{http_code}' http://localhost:8675/_next/static/chunks/<a-chunk-currently-on-disk>.js`
  — a 404 for a file that exists on disk means the process is still pinned to the old
  build. Tell the user to restart in the same message as the rebuild, not at the end of
  the session.

## Advisor: full-width suggestion layout + Automagic v3 research (2026-07-19)

**Layout (user report):** the step-suggestion panel — and especially its expanded
"Analyze dataset" block — rendered jumbled inside column 1 of the Training card's
4/5-column grid, while columns 2-5 sat mostly empty below their few short fields. Fix:
moved the `<StepSuggestion/>` mount in `SimpleJob.tsx` out of column 1 to a sibling
directly after the `trainingBarClass` grid (still inside the Training `Card`, which is a
plain `space-y-2` section with no child-width constraint — so the panel now gets the
full card width with no new wrapper CSS). The per-resolution bucket breakdowns inside
the analysis block moved from a vertical stack into a responsive `grid grid-cols-1
md:grid-cols-2 xl:grid-cols-3` of bordered mini-cards so 512/768/1024 sit side-by-side
on wide screens; summary line, warnings, and the recipe box stay full-width (the recipe
buttons already wrap). FORK_NOTES.md's SimpleJob.tsx merge-surface entry already covers
the mount line; only its position changed.

**Automagic v3 research (folded into recipe notes + the krea2 16GB preset):**

- Mechanics (from `toolkit/optimizers/automagic3.py`, 701 lines, author's docstring —
  the only authoritative source; community data is essentially nonexistent ~6 weeks in):
  ONE adaptive LR per param GROUP (deliberately not per-tensor like v2 — the docstring
  explains per-group pooling stops coupled tensors like Q/K pairs fighting with
  divergent LRs). Sign-consensus controller: each element keeps a packed 1-bit window of
  its last `polarity_history` (default 8) update signs; all-agree votes "step too small",
  perfect-alternation votes "overshoot", everything else abstains as noise; votes are
  magnitude-weighted, pooled to `signal ∈ [-1,1]`, and the group LR moves by
  `lr *= exp(signal)`. Adafactor-style factored second moment (≥2D params), full second
  moment (1D). `fused=True` default (post-accumulate-grad hooks, very low peak VRAM,
  but bypasses trainer grad-clip/nan-skip and is incompatible with multi-backward grad
  accumulation); `fused=False` gives traditional `.step()` with stochastic-rounding
  accumulation.
- Constructor: `lr=1e-6` ("a launch point, not a tuned target — the controller adapts
  away from this in whichever direction the pooled vote points"), `min_lr=1e-8`,
  `max_lr=1e3` (at defaults "purely a numerical overflow guard far outside the usable
  range" — set tighter for a real floor/ceiling; added upstream `cfdc903` 2026-07-17 "to
  prevent runaway edge cases", merged into this fork same day), `beta2=0.999`,
  `clip_threshold=1.0` (RMS trust region + per-element clamp), `weight_decay=0.0`
  (decoupled), warns-not-clamps above lr 1e-3 (v1 force-reset instead). History: 8
  commits Jun 7 → Jul 17 2026, four reworks, "Stable in my testing" Jun 12.
- Per-arch reality: Krea2 is the only arch with real-world automagic3 usage (the
  community 16GB config that became this fork's preset). FLUX.2 Klein has no automagic3
  data, but a 50+-run community study (Calvin Herbst, Medium — single-source,
  style-focused) found Flux-family training extremely LR-sensitive ("changing the
  learning rate by five thousandths of a percent... ripped the image apart — leave it
  alone"), weight decay mattering (1e-5 beat the 1e-4 default for their style runs), and
  dose (steps × batch × accum vs images) the main lever. Illustrious community remains
  on adamw8bit/prodigy (~1e-4–3e-4); Anima's author recipe (adamw 2e-5) outranks
  everything. **Decision: automagic3 guidance added to the krea2 recipe notes only,
  Klein notes get the LR-sensitivity findings (text only, numbers unchanged), and
  Anima/Illustrious recipes deliberately untouched** — per the advisor's honesty rule,
  no data means no recommendation.
- `presets/krea2_lora_16gb.json` → v1.1: added `min_lr: 1e-6` / `max_lr: 1e-4` to
  `optimizer_params` (ceiling = the preset's own start LR so the controller only adapts
  downward, matching the conservative 16GB intent; floor = the optimizer's default
  launch LR). The source config predates the runaway fix and rode pure overflow-guard
  bounds.

**Verified:** tsc clean, preset JSON parses, production build rebuilt cleanly
(BUILD_ID present). Visual layout check deferred to the user's next session on the
running UI (the moved panel + bucket grid are markup/class-only changes with no logic
delta; the state-aware recipe buttons from the prior fix are untouched by the move).

## Phase 6: Training-speed optimization vs OneTrainer (2026-07-19)

Goal: close the per-step speed gap with OneTrainer on the operator's RTX 5090
(primary target: Anima 2B, rank 32 LoRA) without touching the UI and without
un-gated behavior changes. Full change log, merge surface, and the benchmark
protocol live in FORK_NOTES.md ("Speed optimization"); this section records the
audit findings and *why* each change is what it is.

**Code audit at HEAD (2026-07-19) — what was verified before changing anything:**

- Latent caching (`cache_latents_to_disk`) and text-embed caching
  (`cache_text_embeddings`) already work and are already on in the Anima presets.
  With embeds cached the text encoder is *hard-unloaded* (swapped for a
  `FakeTextEncoder` stub, `toolkit/unloader.py`) and cached latents keep the VAE
  parked on CPU (`toolkit/sd_device_states_presets.py`) — the "TE/VAE stay
  resident" gap OneTrainer exploits does NOT exist here anymore. BUT disk-cached
  latents are re-read from disk (safetensors load) plus deep-copied on **every
  fetch, every step** (`toolkit/dataloader_mixins.py get_latent`,
  `toolkit/data_loader.py _get_single_item`); adding `cache_latents: true`
  alongside keeps them in RAM (both flags together = save to disk once, serve
  from memory).
- `gradient_checkpointing` defaults **true** (`toolkit/config_modules.py`) and
  is enabled in every Anima preset — the single biggest config-only win for a
  2B model on a 32GB card (~30-40% step-time recompute tax for VRAM we don't
  need to save).
- Quantization off is genuinely zero-overhead (no wrapper modules left when
  `quantize: false`); attention is torch SDPA by default for Anima; EMA is off
  by default. No action needed on any of these.
- `num_workers` is **hardcoded to 0 on native Windows** (`toolkit/data_loader.py`
  get_dataloader_from_datasets) — the operator's training box. Not safely
  config-fixable: the dataset objects hold live model references, which Windows
  spawn-based workers would have to pickle. Documented as a WSL/Linux note, not
  changed. `pin_memory` is never passed but would be a no-op anyway (custom
  DTO batches, custom collate).
- Per-step hot-loop overhead (the real code-level gap): (a) `torch.isnan(loss)`
  + `.item()` force a CUDA sync every step (`SDTrainer.py`), so the CPU waits
  for the GPU and only THEN does sqlite polling, progress-bar work, and the next
  batch fetch — all of it serialized with GPU compute, which idles meanwhile;
  (b) the UI trainer (`DiffusionTrainer.end_step_hook`) does **4 blocking sqlite
  SELECTs + 1 async write every step**, each SELECT opening a fresh connection,
  on the training thread; (c) automagic-family optimizers add one more sync per
  step via `get_avg_learning_rate()` (left alone — not used by the Anima
  recipe).

**Change 1 — deferred loss sync (`train.loss_sync_every`, default 1 = upstream).**
When > 1, the NaN guard becomes an on-device `torch.nan_to_num` (same net
effect — a NaN loss contributes zero gradient — but no sync, no "loss is nan"
print), and the per-step `.item()` is replaced by `DeferredLossTracker`
(fork-only `toolkit/fork_speed.py`): loss accumulates on-device and syncs to
the host every N steps; between syncs the progress bar / logger receive the
last synced average. Training math is untouched — only display/log cadence
changes. This removes the per-step CPU⇄GPU serialization point so dataloading
and logging overlap GPU compute (the OneTrainer lean-loop pattern) — the win is
largest exactly where the data pipeline is synchronous (Windows, num_workers=0).

**Change 2 — UI DB poll throttle (`train.ui_db_poll_seconds`, default 0 = upstream).**
When > 0, `DiffusionTrainer.end_step_hook` rate-limits its per-step sqlite work
(4 blocking SELECTs + 1 write) to at most once per interval. Cost of enabling:
the UI's stop/save-now/sample-now buttons take up to that many seconds to be
noticed — nothing else changes. 2s is the recommended value (matches the
interval upstream's own commented-out `start_stop_watcher` would have used).
Rare call sites (model load, sample, save) stay unthrottled; the legacy
`UITrainer` (uid `ui_trainer`) is deliberately untouched since the UI launches
`diffusion_trainer`. This also shrinks the SQLITE_BUSY contention window with
the UI's own writers documented in the 2026-07-17 WORKER-crash investigation.

**Change 3 — the 5090 FAST profile** (`presets/anima_lora_5090_fast.json` v1.0 +
`config/examples/train_lora_anima_2b_5090_fast.yaml`): the performance preset
plus every lever above — `gradient_checkpointing: false` (expected single
biggest win on a 2B model; the recompute tax buys VRAM a 32GB card doesn't
need), `cache_latents: true` **and** `cache_latents_to_disk: true` (save once,
serve from RAM — disk-only re-reads every step), `cache_text_embeddings: true`,
batch 4 / accum 1 (same effective batch as the author's 1x4), samples/saves at
500, `loss_sync_every: 4`, `ui_db_poll_seconds: 2`. Training math is identical
to the performance preset; the documented OOM fallback order is batch 2 first,
re-enable checkpointing second.

**Change 4 — benchmark harness** (`scripts/bench_speed.py`): measures
end-to-end steps/s (not just the inner train_loop timer, which misses the
sqlite/logging/progress-bar overhead this phase attacks) by timestamping the
`Timer '...'` blocks that `performance_log_every` prints, per the 200-step /
20-warmup protocol. Sampling disabled and saves pushed out of range for the
run; peak VRAM polled via nvidia-smi; rows append to `docs/speed_benchmarks.md`.

**Status / honesty note:** this branch was authored in a GPU-less cloud
session — all speed reasoning above is verified against the code, but **no
benchmark numbers exist yet**. The run matrix (FORK_NOTES.md "Speed
optimization") is the operator's next action; expectations going in:
checkpointing-off is the dominant term, loss_sync/db-throttle matter more the
faster the step gets (fixed per-step CPU cost), and the OneTrainer comparison
run decides whether Phase 3 (fused backward for AdamW, torch.compile) is worth
its complexity. Phase 3 is deliberately NOT started — it needs the operator's
answers on host OS (torch.compile/Triton viability on native Windows) and on
whether the large-model path matters, plus a measured residual gap to justify
it. The `loss_sync_every` NaN-path nuance is documented in the code comment:
with the gate on, a NaN loss still contributes zero gradient but no longer
prints "loss is nan".

Follow-up to the Automagic v3 research: the user asked whether any help text explains
what the other params should be when Automagic is enabled — answer was no. The Optimizer
select has no docKey, the LR/Weight Decay placeholders ("eg. 0.0001") silently mislead
for automagic3 (LR is a launch point, author default 1e-6; weight decay decoupled,
default 0), and `optimizer_params.min_lr`/`max_lr` have no UI field anywhere (the same
gap `lr_scheduler` has). Upstream's `docs.tsx` was deliberately NOT touched (would add a
merge touchpoint, and its `?`-icon modal is low-discoverability anyway).

New fork-only `ui/src/components/OptimizerHint.tsx`, mounted directly under the
Optimizer `SelectInput` in `SimpleJob.tsx` (one import + one JSX line, same pattern as
the other fork mounts; FORK_NOTES updated). Renders nothing unless an automagic*
optimizer is selected:
- v1/v2: one-line "superseded by v3" note (v1 force-resets LR >1e-3; v2 has the known
  runaway/static-per-tensor issues) + a one-click "Switch to v3" button.
- v3: explains LR-as-launch-point / no-scheduler-needed / decoupled weight decay, and
  shows LR-bound status: green "✓ LR bounded: min – max" when `optimizer_params` carries
  min_lr/max_lr, otherwise an orange "Unbounded" warning with a "Bound it (min 1e-6 ·
  max = LR)" apply button that writes both keys via setJobConfig (mirroring the
  krea2_lora_16gb v1.1 preset values; max = the user's current LR so the controller only
  adapts downward).

Verified: tsc clean, production rebuild clean. (The hint reads
`train.optimizer_params` loosely-typed via a cast since min_lr/max_lr aren't in the
JobConfig type — same as they reach the trainer, which passes optimizer_params through
as an untyped dict.)

## Automagic + gradient accumulation: config-time guard (2026-07-29)

Follow-up to the Automagic v3 research: the "incompatible with multi-backward grad
accumulation" line in the automagic3 docstring (2026-07-19 research, above) was
documented but never enforced. Traced the actual failure mechanism before adding a
guard: with `fused=True` (default for all three Automagic versions; v1/v2 have no
unfused mode at all), each parameter's `register_post_accumulate_grad_hook` fires and
writes the weight update on *every* micro-batch backward
(`jobs/process/BaseSDTrainProcess.py`'s `for b in range(gradient_accumulation)` loop
→ `SDTrainer.train_single_accumulation`'s `accelerator.backward(loss)`), not once per
accumulation cycle. `SDTrainer.hook_train_loop`'s `if not self.is_grad_accumulation_step`
gate — which the trainer relies on to only step/clip once per cycle — never sees the
Automagic case, since the hook already did the step during backward; `clip_grad_norm_`
and the NaN-loss skip, both of which run after backward, are silently bypassed too. Net
effect: N optimizer steps per intended step, each on a partial gradient, with grad
clipping/nan-skip doing nothing — a silent wrong-training bug, not a crash, and nothing
previously caught it.

**Guard** (`toolkit/config_modules.py`, `TrainConfig.__init__`, directly after the
existing `gradient_accumulation`/`gradient_accumulation_steps` mutual-exclusion check):
raises `ValueError` when the optimizer is any `automagic*` AND accumulation is active
(`gradient_accumulation > 1`, or the legacy `gradient_accumulation_steps > 1` or `== -1`
for accumulate-a-whole-epoch) AND the optimizer is fused (`optimizer_params.fused` is
not explicitly `False`). Message states the mechanism, that clipping/nan-skip are
bypassed, and the remedy (v3: `optimizer_params.fused: false`, or accumulation back to
1; v1/v2: no unfused mode exists, accumulation must be 1 — raising batch size is the
preferred alternative to accumulation either way).

**UI mirror** (`OptimizerHint.tsx`): the same three-condition check, computed from
`jobConfig`, renders a red warning block above the existing per-version hint content (in
both the v1/v2 and v3 branches) with one-click fixes — "Un-fuse it" (v3 only, sets
`optimizer_params.fused = false`) and "Reset accumulation to 1" (all versions, zeroes
both `gradient_accumulation` and the legacy `gradient_accumulation_steps`, the latter
read/written defensively since it has no UI field of its own).

**Preset audit** (re-derived directly, not from a stale prior summary — the real preset
count is 17 JSON files, not the higher number an earlier draft of this task assumed;
several named "…laptop16gb" presets referenced in that draft do not exist in this repo
and were not fabricated to satisfy it): only `krea2_lora_16gb.json` uses an Automagic
optimizer (`automagic3`, `gradient_accumulation: 1`, bounded `min_lr`/`max_lr`) — it does
not trip the guard. Exactly one preset uses `gradient_accumulation > 1` at all —
`anima_lora_background.json` (batch 1 + accum 4, optimizer `adamw`) — also on a
non-Automagic optimizer, so it doesn't trip either, but its description now notes that
swapping it to Automagic requires accumulation back to 1. **Net: zero shipped presets
trip the guard; check any future Automagic preset against it before shipping.** The
Krea2 recipe note in `stepSuggestion.ts` (2026-07-19 entry, above) that recommends
Automagic v3 as an alternative optimizer for the 16GB config now also carries the
accumulation caveat, since that note is the one place a user could combine both pieces
of advice into a config the guard would reject.

Verified: `py_compile` on `config_modules.py`; guard fires/doesn't fire per the four
constructed-TrainConfig cases (fused automagic3 + accumulation → raises;
`fused: false` + same accumulation → doesn't; `adamw8bit` + accumulation → doesn't;
`gradient_accumulation_steps: -1` + fused automagic3 → raises); all 17 real presets and
`config/examples/*.yaml` still parse; `tsc --noEmit` and `next build` clean.

**Follow-up, same day — preset audit re-run after a concurrent merge:** the "Add a 16GB
laptop preset tier" commit landed while this work was in progress, adding
`anima_lora_laptop16gb.json`, `flux_lora_laptop16gb.json`,
`illustriousxl_character_lora_laptop16gb.json`, and `sdxl_character_lora_laptop16gb.json`
(21 JSON presets total now). These are exactly three of the four "…laptop16gb" files an
earlier draft of the Automagic task had predicted but which didn't exist at audit time
above — re-running the audit against the merged set: still zero use an Automagic
optimizer (all four are `adamw`/`adamw8bit`), but three of the four now join
`anima_lora_background.json` in the batch-1 + `gradient_accumulation: 4` pattern
(`anima_lora_laptop16gb`, `illustriousxl_character_lora_laptop16gb`,
`sdxl_character_lora_laptop16gb` — `flux_lora_laptop16gb` uses accumulation 1, not
affected). **Net finding unchanged: zero of the 21 shipped presets trip the guard.** All
three gained the same one-sentence Automagic caveat already added to
`anima_lora_background.json`'s description. Re-verified: all 21 presets parse through
`TrainConfig`; `tsc --noEmit` and `next build` still clean.

## Launcher QoL: drop start.bat auto-open, add create_shortcut.bat (2026-07-20)

`start.bat` used to auto-open a browser tab (`start "" "http://localhost:8675"`) on
every launch, including every `npm run start` restart under `concurrently`'s
auto-restart. That line is removed — a fresh tab on every crash-restart was noisy, not
useful. In its place, `create_shortcut.bat` (fork-only, run once) builds a desktop
`.lnk` that targets `start.bat` and uses the UI's own favicon as its icon, so the
day-to-day launch path is "double-click the desktop shortcut" rather than a bare `.bat`
file with no icon. `stop.bat` is unaffected. See `FORK_NOTES.md`'s fork-only file list.

## LDS reconciliation + preset Overwrite UI (2026-07-21)

Follow-up to the 2026-07-19 preset-alignment report, after reviewing LDS commits since
that report. Only one LDS commit since then touches training recipes: `d3d7218`
("tune Klein-style network dims and slider alpha from verified research").

**FLUX.2 Klein style — adopted at half scale.** LDS re-based its Klein STYLE recipe on a
claimed-verified source (Calvin Herbst 64-run sweep + Black Forest Labs' official Klein
training example): a linear+Conv2d LoRA at ratio 4:2:2:1, **128/64/64/32**, alpha =
rank/2, weighted timesteps (other Klein kinds stay linear-only 16/16; LoKr stays
linear-only). 128 linear was judged too heavy for a 4B model, so ATK adopts the same
recipe **folded to half scale**: `flux2_klein_style_lora.json` now ships **64/32 linear +
32/16 conv**. Agreement on shape/ratio/alpha philosophy; deliberate, documented
disagreement on scale (the preset's `meta.description` says how to reproduce LDS's 128
exactly). The size-tiered advisor (`stepSuggestion.ts`) is kind-agnostic — its numbers are
unchanged; its Klein 4B/9B notes now point at the style preset for the conv recipe. LDS's
other `d3d7218` change (slider alpha 4 / scale 0.5) has no ATK preset counterpart and
needs no sync. `docs/preset_alignment_2026_07.md` updated (2026-07-21 section + Klein
rows); the LDS canonical mirror updated to match.

**Preset Overwrite in the UI.** The Presets dialog could save-as-new and delete but had no
first-class way to write the current form back over an existing preset (the POST route
already overwrote silently if you retyped the exact name — invisible and unconfirmed). Added
a per-row **Overwrite** button (`PresetManager.tsx`) that POSTs `configToPreset(jobConfig)`
under the existing name behind a confirm dialog. Shipped/built-in recipes (tracked in git +
the alignment doc) get a stronger warning and a "built-in" tag, but the write is never
blocked — the user asked for it explicitly. Built-in detection is a server-side allowlist
(`BUILTIN_PRESET_NAMES`/`isBuiltinPreset` in `presetsPath.ts`) surfaced as a `builtIn` flag
on the GET route; a user-saved preset is anything not in that set. No new upstream
touchpoints — all changes are in fork-only files. Verified: `tsc --noEmit` clean.

## Help mode toggle on New Training Job (2026-07-27)

Many SimpleJob fields never had CircleHelp docs — only ~25 upstream `docKey`s resolve in
`ui/src/docs.tsx`. Rather than always showing dozens of new icons (or dumping copy into
upstream `docs.tsx`), the fork adds a TopBar **Help** toggle:

- Off (default): only fields with existing always-on help keep their `?` icons.
- On: every other wired SimpleJob field gets a `?` that opens the existing DocModal
  (click → modal, same as Training Name / Unload TE — not hover tooltips).

Implementation:

- `ui/src/hooks/useHelpMode.ts` — session `createGlobalState` toggle.
- `ui/src/components/HelpModeButton.tsx` — TopBar button (mounted in `page.tsx` next to
  Presets).
- `ui/src/forkDocs.tsx` — fork-only `ConfigDoc` registry with source-backed copy for
  model/quantize/target/save/training/dataset/sample/validation/slider fields, plus
  always-on fixes for the dead upstream keys `assistant_lora_path` /
  `unconditional_lora_path`.
- `ui/src/docs.tsx` — tiny `getDoc` fallthrough to `forkDocs` (only new upstream
  touchpoint besides the page/SimpleJob mounts).
- `SimpleJob.tsx` — `const h = (key) => (helpMode ? key : null)` and
  `docKey={h('…')}` on fields that lacked help.

Fork hygiene: help *content* stays in fork-only `forkDocs.tsx`; upstream merge surface
for docs is the three-line `getDoc` merge only. See `FORK_NOTES.md`.

## Fix: modal backdrop blur tanked scroll performance (2026-07-28)

**Symptom (user report):** stutter and frame drops scrolling the preset list.

**Measured, in the operator's Chrome** (the in-app browser pane can't be used for this —
when it isn't displayed the page doesn't composite, so `requestAnimationFrame` never fires
and long-task/frame timings are unavailable):

| | frames in 12s | effective fps | median frame |
|---|---|---|---|
| `backdrop-blur-sm` ON | 169 | ~14 | 89.9 ms |
| blur OFF | 712 | ~59 | 16.6 ms |

**Cause:** `Modal.tsx`'s backdrop is `fixed inset-0` with `backdrop-blur-sm`. A
full-viewport backdrop-filter must be recomposited every frame while anything above it
scrolls, over the whole New Job page (the app's heaviest route). Cost is ~73 ms/frame —
entirely GPU compositing, with a `longtask` PerformanceObserver recording **zero**
main-thread blocking throughout. Fixed by deleting the class; `bg-opacity-75` still dims
the page so the modal is visually unchanged.

**Two dead ends worth recording, both methodology errors:**

1. The first blur A/B drove scrolling by assigning `scrollTop` each frame and reported *no
   difference* (4.2 ms both ways, zero dropped frames). Programmatic scrolling does not
   exercise the same paint path as real input — it produced a false negative that
   temporarily cleared the actual culprit. **Any scroll-performance test here must use real
   wheel/trackpad input.**
2. The `Jobs:` console flood from `useJobsList` (a `console.log` on every poll, plus
   `setJobs` on a fresh array every 5 s via `ActiveJobWidget`, guaranteeing a re-render even
   when the list is unchanged) looked like a strong suspect and is not: long tasks stayed at
   zero across it. Still a real if harmless inefficiency in upstream code, and the polls
   arrive in **pairs ~3 ms apart** even though `ActiveJobWidget` is mounted once
   (`Sidebar.tsx:81`), so something drives that hook twice per cycle. Not investigated.

Note the operator's laptop panel runs at ~217 Hz (4.6 ms budget), which is what made this
so visible; dropping to 60 Hz was the diagnostic that produced the clean A/B above.

## Fix: loading almost any preset crashed the form (2026-07-28)

**Symptom (user report):** loading a preset replaced the whole form with a red
"Advanced job detected. Please switch to advanced view to continue." That message is
misleading — it is not a detection of anything. It is the `fallback` of the
`ErrorBoundary` wrapping `<SimpleJob>` in `jobs/new/page.tsx`, so it renders whenever
SimpleJob *throws* for any reason.

**Root cause:** `TypeError: Cannot read properties of undefined (reading 'weight_decay')`
at `SimpleJob.tsx:740`, which dereferences `train.optimizer_params.weight_decay`
unguarded. `applyPreset()` (fork-only `ui/src/utils/presets.ts`) is supposed to fill gaps
from `defaultJobConfig` — its own docstring promises "missing fields are filled from the
defaults so the simple form never hits undefined values," and PLAN.md Feature A says
"partial configs are fine." It didn't. `deepMerge` replaces arrays wholesale (correct for
datasets/sample prompts — they're recipes, not lists to union), but `config.process` is
*itself* an array, so the preset's one-element `process` array replaced the default's
entirely, discarding every default inside `process[0]`. Datasets were re-merged against
`defaultDatasetConfig` afterwards; `process[0]` never was.

**Blast radius: 20 of the 21 shipped presets.** Only `krea2_lora_16gb` set
`optimizer_params` explicitly, so it was the single preset that loaded. Reproduced live on
the untouched built-in `anima_lora_background`, so this long predates the laptop tier —
the laptop presets just happened to be what the user loaded first.

**Fix:** re-merge `process[0]` against `defaultJobConfig`'s `process[0]` right after the
top-level merge, mirroring how datasets are already handled. Fixes every missing optional
key at once rather than only the one field that happened to crash. Deliberately NOT fixed
by guarding the read in `SimpleJob.tsx` — that's an upstream file (new merge surface), the
crash is generic rather than specific to that field, and the real defect is in the fork's
own merge.

**Verified:** merge logic exercised against seven real preset files (the four laptop ones
plus anima/sdxl/flux/krea2/zimage/klein built-ins) — all now resolve `weight_decay` from
defaults while the preset's own lr/batch/optimizer/steps still win over the default, i.e.
merge direction is correct. `tsc --noEmit` clean in `src/`, production build clean.
Note that `next start` caches its build manifest at startup, so the running server keeps
serving the old chunk until it is restarted (`stop.bat` then `start.bat`) — a rebuild
alone is not enough to see this fix.

## 16 GB laptop tier (2026-07-28)

The fork gained a second machine: an RTX 5080 Laptop (16 GB VRAM, ~15.9 GB usable),
Core Ultra 9 275HX, 96 GB system RAM, native Windows. Every hardware-tuned number in
this repo up to now was calibrated for the 32 GB desktop 5090 — `docs/profiles.md`
says so explicitly ("batch size sized to use most of the 32 GB"). On half the VRAM the
`performance`/`background` split collapses: `background` *is* the performance option,
and there was no tier below it for any arch except Krea 2 (`krea2_lora_16gb`).

Four new fork-only presets, all suffixed `_laptop16gb`: anima, flux, sdxl character,
illustrious character. Chosen because these are the four archs where the existing
presets leave a real gap on 16 GB — Krea 2 already has a purpose-built 16 GB profile,
and the Z-Image / FLUX.2 Klein presets are already quantized + `low_vram` + batch 1, so
a variant would differ only cosmetically. (Those two could still gain the RAM-latent-cache
flag if a run ever shows it matters.)

**These are profiles, not recipes.** Every rank/alpha/LR/optimizer/scheduler/steps value
is inherited unchanged from the parent preset, so checkpoints remain interchangeable and
none of the contested numbers from Phase 3 / the LDS alignment are touched. The full
lever list and rationale live in `docs/profiles.md`'s new `laptop16gb` section; the short
version is RAM-served latents (`cache_latents` *plus* `cache_latents_to_disk`),
`low_vram: true`, 768 preview sampling on the flux-family models, and batch 1 + accum 4
on SDXL/Illustrious.

That last one is the notable finding of this pass: **the advisor will suggest a batch
size that OOMs this card.** `ARCH_RECIPES` recommends batch 4 for vanilla SDXL
(`stepSuggestion.ts:250`), SD 1.5 (`:266`) and Illustrious (`:386`), and batch 2 for Pony
(`:401`) — all sized for the 5090, and the recipe table has no VRAM awareness whatsoever.
Deliberately **not** fixed in code: making `ARCH_RECIPES` hardware-aware would mean the
advisor knowing the local GPU (a new API surface + a new class of wrong answer on a
machine it guesses badly for), and the honest fix at preset level costs nothing. The
laptop presets encode the safe batch, and their `meta.description` plus `docs/profiles.md`
warn against the batch Apply button specifically, while noting the rank/alpha/LR/scheduler
buttons stay safe. Revisit if a third machine makes this a recurring footgun.

**Status: unmeasured.** Authored and validated statically only — no training run has been
made on the 16 GB machine, so no VRAM figure in `docs/profiles.md`'s new section is a
measurement on this hardware (the 14.1 GB peak it reasons from is the 5090 gate-C number).
FLUX.1-dev is flagged as the highest-risk of the four: 12B params, and `flux_lora_24gb` is
named for a 24 GB card. Each preset documents its own OOM fallback order.

Also fixed in the same pass: the four new names were added to `BUILTIN_PRESET_NAMES`
(`ui/src/server/presetsPath.ts`) so the Presets dialog's Overwrite button flags them as
provenance-tracked, per the 2026-07-21 note that the allowlist must stay in sync with what
ships in `presets/`. No new upstream touchpoints — every changed file is fork-only.

## Effective batch capped at 2 across all recipes and presets (2026-07-29)

Operator report: the advisor's step suggestions "end up being highly inaccurate" and
overfit on their datasets whenever batch or accumulation is 4. Traced it — the complaint
is exactly right and the mechanism is an interaction the advisor never surfaced.

**Root cause.** `suggestSteps()` computes `raw = itemCount × stepsPerItem ÷ effectiveBatch`,
then `clamp(raw)` to the arch's `[minSteps, maxSteps]`. Dividing by effective batch is
correct on its own, but for a small/medium dataset at effective batch 4 the quotient lands
*under* `minSteps` and the floor raises it back up. Real exposure is
`steps × effectiveBatch ÷ items`, so once the floor is doing the work, exposure scales
with effective batch instead of being held constant by it — and nothing in the returned
explanation said so. Measured against the arch targets (SDXL 100×/img, Anima 75×/img):

| images | eff batch 4 | eff batch 2 |
|---|---|---|
| SDXL 20 | 1200 steps → 240×/img 💀 | 1200 steps → 120×/img ✅ |
| SDXL 25 | 1200 steps → 192×/img 💀 | 1250 steps → 100×/img ✅ |
| SDXL 30 | 1200 steps → 160×/img 🔥 | 1500 steps → 100×/img ✅ |
| Anima 25 | 1000 steps → 160×/img 💀 | 1000 steps → 80×/img ✅ |
| Anima 30 | 1000 steps → 133×/img 💀 | 1100 steps → 73×/img ✅ |

The advisor was recommending step counts that its **own** `exposureGauge()` would have
banded 💀 fry-risk. That is the "inaccuracy" — not the step number in isolation, but the
suggestion and the gauge disagreeing because only one of them accounted for the floor.

**Changes.** Every recipe and preset now caps effective batch at 2:
- `stepSuggestion.ts`: `batchSetting(4)` → `2` for `sdxl`, `sd15`, and the Illustrious
  branch of `illustriousOrPonyRecipe`; Anima's `rec('grad accum 4', …, 4)` → `2`. Pony was
  already 2, and the flux/krea2/zimage/klein/anima batch-1 recipes were already ≤2.
- Presets (6 of 21 were above the cap): `anima_lora_performance` and `anima_lora_5090_fast`
  batch 4→2; `anima_lora_background`, `anima_lora_laptop16gb`,
  `illustriousxl_character_lora_laptop16gb`, `sdxl_character_lora_laptop16gb` accumulation
  4→2. `config/examples/train_lora_anima_2b_5090_fast.yaml` batch 4→2 with its header.
- **Deliberate deviation from the Anima author's published recipe**, which specifies
  effective batch 4 and is otherwise the highest-confidence source in this fork. Only the
  batch changed; rank 32 / alpha 32 / AdamW / LR 2e-5 / frozen adapter are untouched author
  values. Flagged in-place in the recipe notes and all three Anima preset descriptions with
  instructions to set it back to 4 to reproduce the author's config on a large dataset —
  the provenance is preserved, not overwritten.
- **LRs deliberately not touched.** Linear-scaling convention would suggest lowering LR
  alongside effective batch, but the fork's LR values are researched/contested per arch
  (Flux family especially: "leave the learning rate alone"), and changing two axes at once
  would destroy the ability to attribute a result to either. Halving effective batch with
  a fixed LR is a mild, well-tolerated change at LoRA scale.
- **Preset `steps` deliberately not touched.** Presets don't know dataset size, so their
  step counts are generic placeholders; halving effective batch halves exposure at the same
  step count, which is the direction the overfitting complaint asks for.

**Also fixed: the floor is no longer silent.** `suggestSteps()`'s explanation now appends a
note whenever `raw < minSteps`, stating that the floor raised the number, what the computed
value was, that exposure is running above the arch target, and that lowering effective batch
is the lever. This matters because the cap to 2 does not fully solve very small datasets —
at ≤15 images the floor still dominates (SDXL 15 img @ eff 2 = 160×/img 🔥, Anima 15 @ 2 =
133×/img 💀). Those cases now say so instead of presenting a fry-range number as authoritative.

Verified: all 21 presets parse through `TrainConfig`; the fast yaml parses; `tsc --noEmit`
and `next build` clean; re-audit confirms no preset or recipe exceeds effective batch 2.

## Krea 2 guidance from a measured 16GB run (2026-07-29)

A public write-up reported the first real measured Krea 2 LoRA run on a 16GB card (RTX 5080,
768px, 36 images, 1152 steps, 3.42 s/it, 15,284/16,303 MiB peak), together with a critical
reply. The operator trains Krea 2 on a 16GB 5080 laptop, so both were worth mining — but the
run used **musubi-tuner (kohya), not ai-toolkit**, so most of it does not transfer. What was
checked against this codebase before adopting anything:

| Claim in the write-up | Verdict here |
|---|---|
| `--fp8_base/--fp8_scaled`, `--blocks_to_swap` tuning | Not applicable — this trainer uses `quantize`/`qtype`, `low_vram`, `layer_offloading_*` |
| Must use `krea2_shift` instead of `shift` + `discrete_flow_shift 2.5` | **Already solved here.** `extensions_built_in/diffusion_models/krea2/krea2.py:79-93` configures Krea's resolution-aware exponential mu schedule natively (`base_shift 0.5`, `max_shift 1.15`, `use_dynamic_shifting: True`). No such knob exists or is needed |
| Don't feed musubi the pre-quantized ComfyUI fp8 file | Partly relevant — our loader (`krea2.py:127-163`) accepts a single `.safetensors` file, a dir, or a hub repo id, so a Comfy mirror file loads via local path; the hub path expects a file literally named `raw.safetensors`, so the repo id can't just be swapped |
| Official `krea/Krea-2-*` repos are gated | True, and upstream added `gateUrl` for krea2 in the same-day sync. Only the DiT is gated — the TE is separately configurable (`model_kwargs.text_encoder_path`, default `Qwen/Qwen3-VL-4B-Instruct`) |
| rank 32 / alpha 32 / LR 1e-4 / adamw8bit | **Corroborates** the existing `ARCH_RECIPES.krea2` numbers — the strongest support they have had |
| 32 passes/image was the best checkpoint | **Adopted** — see the tiering below |

On the critical reply: two of its four points misread the source (it trains on RAW, and it
explicitly declines to claim a fix), and its resolution point doesn't implicate us since
`krea2_lora_16gb` already used 512. Its bleed claim is half right and worth encoding: trigger
bleed *is* structurally normal (a LoRA shifts weights globally and cannot scope itself to a
token), so the write-up's "I did it to myself in the captions" was over-attributed — though
its control grid (near control bled, distant controls stayed clean) is real evidence that
captions modulate *what* binds. Its most useful contribution is that the actual remedies —
DOP and regularization images — exist in ai-toolkit and not in musubi.

**Change 1 — Krea 2's step target is now dataset-size tiered** (`stepSuggestion.ts`,
`ARCH_HEURISTICS.krea2`): small 45 / medium 32 / large 20, replacing a flat 65.
- medium 32 is the *measured* anchor: 36 images x 32 = 1152, reproducing the run's step count
  and its chosen checkpoint exactly (our clamp rounds to 1150). The run rated epoch 8 (16
  passes) "solid", epoch 12 (24) already over-idealized, epoch 16 (32) most faithful.
- large 20 comes from the pre-existing in-code note that published 100-500 image recipes
  converge at ~15-20 passes/image — the same note that flagged the flat 65 as over-warning.
- small 45 is **extrapolation, not measurement**, and is labelled as such in the code.
- Mechanics: `ARCH_HEURISTICS` values may now be `StepHeuristic | ((tier) => StepHeuristic)`;
  only krea2 is a function, every other arch is untouched. `getHeuristic(arch, tier?)` defaults
  the tier to `'medium'` so the exported signature stays backward-compatible, and both call
  sites (`suggestSteps`, `exposureGauge`) pass `getSizeTier(itemCount)` so the suggestion and
  the gauge resolve the *same* target — that divergence is precisely the bug the same-day
  effective-batch work was about.
- Not raising `maxSteps`: at 400 images the 4000 ceiling, not steps/item, is what still
  under-reports. Tiering moves that ratio from 0.15 to 0.5 but doesn't fix it; raising the
  ceiling needs its own evidence.

**Change 2 — new `presets/krea2_lora_laptop16gb.json`**, the missing krea2 entry in the
laptop tier. Follows the established pattern exactly: every recipe value inherited unchanged
from `krea2_lora_16gb` (so checkpoints stay interchangeable), varying only memory/IO —
`cache_latents` alongside `cache_latents_to_disk`, preview sampling 1024 -> 768,
`ui_db_poll_seconds: 2`. Registered in `BUILTIN_PRESET_NAMES`. Effective batch stays 1, within
the cap set the same day. Resolution deliberately stays 512.

**Change 3 — DOP / regularization documented, not wired.** The krea2 recipe notes and both
16GB preset descriptions now state that trigger bleed is normal, that
`train.diff_output_preservation` and reg datasets (`is_reg`/`reg_weight`) are the real levers,
and the two constraints that would otherwise be silent failures: DOP **requires a
`trigger_word`** (`SDTrainer.py:90` raises without one, and no krea2 preset sets one) and is
**mutually exclusive with `cache_text_embeddings`** (`config_modules.py:1527`), so it can't be
combined with the cache-embeds memory strategy and costs ~a second forward pass per step.
Deliberately not enabled in any preset — that would ship a config that errors until edited.
The caption advice is kept as the cheaper secondary measure and explicitly labelled a
hypothesis its author never re-ran.

Verified: all 22 presets parse through `TrainConfig`; `tsc --noEmit` and `next build` clean;
numeric check confirms 36 images -> ~1150 steps / 32 passes, 20 -> 45, 200 -> 20; no new
upstream touchpoints (`stepSuggestion.ts` and `presetsPath.ts` are both fork-only).

## start-rebuild.bat: one-click update + rebuild + launch (2026-08-02)

`start.bat rebuild` covers "reinstall and rebuild the UI", but the update itself was still
manual (`git pull`, then remember the `rebuild` argument, then find out the hard way that
the old server is still running). `start-rebuild.bat` (fork-only, root) is the single
double-click that does all of it, in this order:

1. **Dirty-tree guard.** `git status --porcelain` non-empty -> abort with the short status.
   No stash, no `-f`. (Verified on first run: the script's own untracked file tripped its
   guard, which is exactly the intended behavior.)
2. **`git fetch origin` + `git pull --ff-only origin <current branch>`.** Fast-forward only,
   `origin` only. It will never merge, rebase, or force, and it deliberately does **not**
   touch `upstream` — merging `ostris/ai-toolkit` stays a manual/`/sync-upstream` job with a
   human reading the delta (see the sync procedure at the top of FORK_NOTES.md).
3. **Stop the running server** using `stop.bat`'s exact command-line matcher (port 8675 UI +
   `cron/worker.js`), then a 2s settle. This step is the actual reason the script exists:
   `npm ci` deletes `node_modules` and fails with `EPERM: unlink
   node_modules/.prisma/client/query_engine-windows.dll.node` when the UI is live — and it
   fails *after* having already deleted most of the tree, so a naive "rebuild while running"
   leaves a broken install behind (hit for real during the 2026-08-02 upstream sync).
   Detached training (`run.py`) is left alone, same as `stop.bat` without `all`.
4. **`npm ci` -> `npm run update_db` -> `npm run build` -> `npm run start`.** `ci`, not
   `install`, so `ui/package-lock.json` stays byte-identical to upstream (FORK_NOTES rule).

If the pulled range touched any `requirements*.txt` it prints a warning to reinstall the
python training deps by hand; the script never touches the venv.

`start.bat` is unchanged and remains the normal launcher; `create_shortcut.bat` still points
at it.

## Phase 7: run a job on another machine's GPU (2026-08-04)

### Why

Two machines, one of them usually idle. Everything about a training run already lives in a
`Job` row and a folder; the only thing tying it to this box was the `spawn` call. The goal
was to pick another machine in the GPU picker and have the run happen there, with the job
page behaving exactly as it does for a local run.

### The three decisions that shaped it

**1. Identity goes in `gpu_ids`, not in the schema.** Fork rule 2 forbids Prisma changes,
which at first read looks like a blocker for "which machine runs this". It is not:
`Queue.gpu_ids` is `String @unique` and `processQueue` groups jobs by an exact string
match on it. Encoding the machine as `"<peerId>:<localIndex>"` therefore gives each remote
GPU its own queue, with its own one-job-at-a-time concurrency, **without editing
`processQueue.ts` at all**. `'mps'` was already proof the column carries non-numeric
values. The rule pushed toward the better design rather than around it.

**2. The peer runs unmodified.** Everything the hub needs was already a public route on any
ai-toolkit instance. Nothing is installed on the peer and it needs no awareness of the hub
— it just sees an ordinary job appear in its own queue and UI. This is the property that
makes SwarmUI's remote-instance backend cheap to maintain, and it is worth defending: the
moment the peer needs a special endpoint, upgrading the two machines independently stops
being safe.

**3. Mirror home rather than proxy.** The watcher writes the same `Job` row and the same
`{TRAINING_FOLDER}/{job.name}/` folder that a local run produces — status, step count, log
bytes, sample images, `.safetensors`. The consequence is that **zero UI code changed**: the
job page, the log tail, the sample grid and the file list all work against a remote run
without knowing it is remote. Base model weights deliberately do not cross; the peer
downloads its own with its own HF token, and those are far larger than anything else here.

### Borrowed rather than rediscovered

The sibling project (LoRA Dataset Studio) has run passes across two machines for a while,
and its written-up failures shaped four things here:

- **Resume is a manifest, not a guess.** A `.hub_manifest.json` of `name -> size:mtime` is
  uploaded *after* the files it lists, so an interrupted staging leaves the older, smaller
  manifest and the next run re-sends the gap. An edited image changes signature and is
  re-sent. LDS's equivalent bug — a returned cache that silently overwrote a good local one
  — cost several full re-runs before it was noticed from the artifacts on disk.
- **Downloads resume.** LDS measured an 85 MB checkpoint needing roughly 100 resumed
  connections over a home link; a single-shot GET would never have finished. The peer's file
  route already serves `bytes=N-` to EOF.
- **Cancel is wired on day one.** LDS shipped remote paths whose stop flag was read and
  discarded, twice — its remote training and remote ComfyUI jobs both ignored it. Here the
  watcher checks the local `stop`/`return_to_queue` flags every tick and forwards them.
- **Failures are never invented.** LDS had a hard-coded `returncode = 0` that made every
  remote failure report the same meaningless exit status. Every failure path here names the
  machine and carries the peer's own message.

### Limits, stated rather than discovered later

- A dataset with subfolders, or with a `control_path`, is refused **before** anything is
  uploaded. The peer's upload route flattens into one directory, so a nested layout would
  train against a different dataset than the one configured.
- No loop guard: pointing a peer entry at this same instance is not detected.
- The peer's queue is its own. A job started on the peer directly puts the hub's job behind
  it; the hub reports `queued`, which is true, but cannot say what it is waiting for.
- The optimizer state is not copied back, so a run cannot be resumed on a different machine
  than it started on.

### What was NOT built

A capability handshake beyond "what GPUs do you have". The hub does not check that the peer
can train the selected architecture — a peer on older code with no support for the chosen
model fails at run time with the peer's own error. Adding a real version/feature exchange is
the obvious next step if the two machines ever drift.

### Fixed after the fact (2026-08-04)

**The watcher did not recognise a SUCCESSFUL run.** `TERMINAL_STATUSES` was
`['stopped', 'error']`, so the one ending that matters — a clean finish — fell through: the
poll loop would have run forever against a finished job, and `mirrorCheckpoints` would never
have fired, leaving the weights on the peer with a hub job row that said `completed` and an
empty folder beside it. The two failure endings both worked, which is exactly why it read as
correct.

The cause was writing that list from `JobStatus` in `ui/src/types.ts` — a six-member union
where `stopped` sits next to `completed` and looks like the same thing. The authority is the
trainer: `extensions_built_in/sd_trainer/UITrainer.py:246` does
`update_status("completed", "Training completed")` on a clean exit, and `DiffusionTrainer.py:355`
does the same. `queued`, `running` and `stopping` are the transient three.

Found while building the sibling project's picker on top of this, which had inherited the
same wrong list — **the same bug in two repos, from one misreading.** Both are fixed;
LDS pins it with a test against the real status strings rather than against its own set,
since a test written from the same list would have inherited the same hole.

## Phase 8: fork hardening + measured hot-path pass (2026-08-10)

This pass deliberately optimized the fork as a whole rather than importing another upstream
feature. The constraints stayed the same: preserve the advisor/presets, remote execution,
Automagic guard, effective-batch cap, and the unmodified-peer contract; add no npm dependency
or Prisma schema; keep new logic in fork-only files where possible; document every unavoidable
upstream touchpoint.

### Training: remove a real CUDA barrier, preserve failure semantics

`get_mean_flow_guided_loss()` contained `if loss.item() > 1e3: pass`. The comparison did
nothing but `.item()` forced a device-to-host synchronization on every affected step. An
isolated 2,000-iteration CUDA microbenchmark on the operator's RTX 5090 measured 0.0778s with
the synchronization and 0.0318s without it (2.44x for that isolated pattern; it is not an
end-to-end trainer speedup claim). The two dead lines were removed.

The audit also caught a correctness regression in Phase 6's fast path. Bare
`torch.nan_to_num(loss)` zeros NaN but converts `+inf`/`-inf` to the dtype extrema (about
±3.4e38 for fp32); upstream's synchronous `isfinite` branch zeros every non-finite loss.
`neutralize_nonfinite_loss()` now passes explicit replacements for all three values, stays
on-device, and has CPU tests covering values, dtype/device, and finite-gradient passthrough.

It is **not** equivalent to upstream's synchronous branch, and the first version of this note
claimed it was. Upstream substitutes `torch.zeros_like(loss).requires_grad_(True)` — a detached
leaf that cannot backprop at all. `nan_to_num` returns a node still wired into the graph that
produced the bad number; its own backward zeroes the gradient where the input was non-finite,
but zero times an infinity already sitting upstream is still NaN. So the fast path fixes the
reported *value* and does not give the guard's isolation. That is the actual trade behind
`loss_sync_every > 1`, it is now stated in both the helper and the call site, and a test asserts
the returned tensor keeps its `grad_fn`.

### Dataset routes: one containment rule for reads, writes and deletion

The fork's 2026-07-19 browser work had already documented why `path.basename('..')` is not a
traversal defense, but the older create/delete/upload routes and the newer Dataset Tools route
had not all adopted that rule. The delete route could recursively remove outside the datasets
root; upload had the matching write primitive.

`ui/src/server/datasetPath.ts` now owns the pure validation and containment rules: validate
exactly one top-level component, resolve it strictly below `DATASETS_FOLDER`, and detect
case-insensitive destination aliases. `datasetFiles.ts` re-exports them so existing imports stay
stable. Create, delete, upload, count, analyze, browse and Dataset Tools all resolve the top-level
dataset through that helper. Mutation routes reject invalid input with 400 before filesystem
work; upload validates and deduplicates the entire sanitized filename set before `mkdir` or the
first write, preventing both partial uploads and silent overwrites. The helper is dependency-free
and covered by Node tests for empty/dot/dotdot, both separators, valid names, collisions, and a
filesystem-volume root.

### UI/background work: bounded resources and single-flight refreshes

- Dataset Tools replaced its one-second `setInterval` with the existing post-settle
  `usePollLoop`: slow requests cannot overlap or resolve out of order, and a transient failure
  is retried instead of permanently stopping the display. Each attempt has a ten-second Axios
  timeout and is aborted when the modal closes or the watched run changes.
- Tool runs remain registered for their full process lifetime. Error/close finalization is
  idempotent, the per-dataset lock is removed only if it still names that run, and the one-hour
  retention countdown begins after completion rather than after launch.
- `presetsPath.ts` now uses the shared server Prisma singleton instead of spawning another
  query engine/SQLite pool.
- `apiCache.ts` shares an in-flight promise independently of its result TTL and starts the result
  TTL when work completes. This closes the concrete case where a six-second peer probe behind a
  five-second TTL could be launched twice concurrently. A never-settling fetch becomes replaceable
  after 30 seconds, old completions cannot overwrite their replacement, and rejections remain
  evicted for immediate retry. Every `nvidia-smi` subprocess is also bounded to ten seconds.
- Upstream's 2026-08-14 always-on SSE device monitor replaced local UI polling with a resident
  `nvidia-smi` loop and a one-shot fallback. The loop has its upstream watchdog; the fork adds the
  same ten-second timeout to the fallback so a hung driver cannot pin the monitor tick forever.
  Remote machines remain unmodified and are still probed through their stock `/api/gpu` route.
- Saving Peer Settings invalidates `peer-machines` before the UI's immediate refresh, so an
  added/removed machine no longer reappears as the five-second-old cached list.

### Remote execution: exact inputs, acknowledged cancellation, current artifacts

The peer remains an ordinary unmodified ai-toolkit install. The hub now rejects two local
filenames that collapse to the same peer-sanitized name before uploading anything. Names that
sanitize to the *same string* alias on every filesystem and are always fatal; names that differ
only in capitalization alias only on a case-insensitive peer, so those are fatal by default and
allowed when the peer record carries `"caseSensitiveFs": true`. Without that escape hatch a
Linux hub sending a Linux peer `IMG.JPG` beside `img.jpg` failed a job that had staged fine for
months. The flag is preserved across peer-settings saves the same way the auth token is — the
editor never renders it, so an entry returning without it means "unchanged", not "cleared".

Each staging directory includes a stable hash of the real database Job id, so distinct job names
that sanitize identically cannot share a peer folder. If the peer *answers* and the manifest is
missing, unreadable, empty or malformed, or if a trusted manifest contains a file removed
locally, the hub deletes only its generated per-job staging dataset through the peer's existing
delete route and performs one full re-upload. If the peer does not answer at all — a timeout, a
refused connection — that is evidence of nothing and must not authorize a delete: the hub
re-sends the files and leaves the folder alone. `PeerError` already carried a `status` field for
exactly this distinction ("the peer said no" vs "the peer is not there"). The reset call is also
wrapped: a folder that was never staged 404s on delete, and no manifest problem should ever fail
a training job. Additions and edits remain incremental and the manifest is still written last.

A stop request is marked sent only after the peer acknowledges it, so a timeout retries on the
next watcher tick. Terminal checkpoints are downloaded to a temporary file in the destination
directory, checked against the peer-reported size, and atomically renamed over any same-name
artifact — but a checkpoint already on disk at the peer-reported size is skipped outright, since
checkpoints are immutable once written and re-queueing a finished job must not re-pull gigabytes.
A local copy at a *different* size is replaced, which is the case the pre-existing `existsSync`
skip got wrong.

The temporary path is derived deterministically from the destination (a short hash of its
basename) and nothing else. That is load-bearing: `peerDownloadFile` resumes a transfer from
`${downloadPath}.part`, which it stats on entry, so a path containing a PID or a UUID silently
disables resume — and this file's own comments note a home link needing roughly 100 resumed
connections for one checkpoint. For the same reason a transfer that breaks mid-flight keeps its
`.part` file; only a completed-but-wrong-size download discards it, because those bytes are
proven bad. Hashing also keeps the component short for long checkpoint names, which is what the
PID/UUID scheme was reaching for. Windows replacement semantics were exercised directly on this
machine. Cleanup retries transient Windows sharing errors and reports any artifact it still
cannot remove without masking the original transfer failure.

Tool runs stay registered after they finish, too. `getActiveRun` is the only lookup behind
`GET /api/datasets/tools?datasetName=`, so unregistering a completed run made reopening the
Dataset Tools modal show an empty panel instead of the finished log; the one-hour retention timer
now clears both maps together, and exclusivity still works because `startToolRun` tests
`status === 'running'`. The modal's poll reports its own failures as well: `usePollLoop` swallows
a rejection and keeps retrying, which is the right behavior for a blip but showed the user
nothing, leaving the panel on "running" forever with no explanation.

That registration/retention policy now lives in fork-only `ui/src/server/toolRunRegistry.ts`,
split out of `datasetTools.ts` for the same reason `remoteIntegrity.ts` was split out of
`startRemoteJob.ts`: the module it came from spawns Python and reaches Prisma through
`cron/paths`, so none of these rules could be covered without standing both up. The registry
imports nothing, takes an injectable timer, and is tested for the four things that matter — a
finished run stays discoverable, the per-dataset writer lock still frees up, retention clears both
lookups together, and a stale run's timer cannot evict its replacement. That last pair is what
kept the fix honest; before the extraction this was the one finding of the seven shipped without
a test.

### Captioner baseline repair and regression coverage

`ideogram4_prompt.py` contained a literal `\uNNNN` inside a normal triple-quoted Python string,
which is an incomplete Unicode escape and prevented the module from compiling. Making the
prompt raw both restores importability and preserves its intended literal `\uNNNN`/`\n`
instructions. The new regression test imports the real module and asserts those examples.

Verification for this phase: focused Python and Node tests, worker/source TypeScript checks, a
production Next build, full Python compile, and a fork-merge-surface check. `ui/package-lock.json`
is unchanged — this phase adds no dependency. `ui/package.json` gains exactly one line, a `test`
script, because the 400-odd lines of Node regression tests added here otherwise only ran if
someone typed the full `node --test` invocation by hand. That makes it the 23rd upstream file on
the merge surface; it is in the FORK_NOTES table with the rest.

None of this phase's remote-execution work has an automated end-to-end gate: `startRemoteJob`,
`mirrorCheckpoints` and the `peerDownloadFile` resume path have no harness, and the SDTrainer loss
path needs a GPU. The unit tests cover the extracted primitives in `remoteIntegrity.ts` — that is
why they were extracted — but the wiring between them is verified by reading and by real
two-machine runs, not by CI.

## Upstream per-dataset batch integration (2026-08-21)

Upstream added an optional `batch_size` to each dataset config. Bucketed datasets already emit
pre-batched items before `ConcatDataset` combines them, so an override changes the real number of
images consumed by a training step. The fork's advisor previously assumed every selected dataset
used `train.batch_size`; after adopting upstream unchanged, that would make its step suggestion,
exposure gauge, and thin-bucket warnings disagree with the trainer.

For mixed batches, the advisor now computes the item-weighted harmonic mean:
`total selected items / sum(dataset items / dataset batch size)`. Multiplying that microbatch
size by gradient accumulation reproduces the global-batch formula when no override is set and
correctly models the number of passes when datasets use different batches. The calculation lives
in dependency-free `ui/src/utils/advisorBatch.ts` with Node regression coverage. Thin-bucket
warnings are evaluated separately for each dataset at its own batch size because upstream batches
inside each `AiToolkitDataset`; pooling dimension counts first would hide a thin bucket in one
dataset behind images from another.

The existing recipe cap remains a recommendation on train-level settings, not a prohibition on
upstream's manual dataset override. Scope and batch stay orthogonal: the fork first counts the
selected loose/child files with repeats, then applies that dataset row's batch size.

## Effective batch: flat cap of 2 replaced by a size-gated ceiling of 4 (2026-08-24)

Operator correction to the 2026-07-29 decision: they run **batch 1, 2 or 4 depending on the
VRAM of the machine they are on**, and asked that the advisor's numbers be correct at all
three rather than that batch 4 be forbidden. Their working dataset range is 20-150 images.

**Why the flat cap was the wrong shape.** The 2026-07-29 diagnosis was right and is unchanged:
`suggestSteps()` computes `raw = itemCount x stepsPerItem / effectiveBatch`, clamps to
`[minSteps, maxSteps]`, and once the floor is doing the work, real exposure
(`steps x effectiveBatch / items`) scales *with* effective batch instead of being held constant
by it. Capping at 2 avoided the bug on most datasets but did not fix it — it also banned batch 4
on the large datasets where it is not merely safe but correct, and it silently overrode the Anima
author's published recipe everywhere rather than only where the floor actually binds.

**The fix is a computed ceiling, not a constant.** In `ui/src/utils/stepSuggestion.ts`:

- `bandForRatio()` extracted as the single source of truth for the exposure bands.
  `exposureGauge()` now calls it instead of carrying its own copy of the thresholds. The
  2026-07-29 bug was in essence the suggestion and the gauge disagreeing; they can no longer
  hold different opinions about where the fry band starts.
- `EFFECTIVE_BATCH_LADDER = [1, 2, 4]` — the batches this fork actually ships settings for.
- `maxHealthyBatch(itemCount, arch)` — largest ladder entry whose floor-clamped suggestion stays
  out of the fry band. Exposure is non-decreasing in effective batch (steps fall until the floor
  binds, then hold while the multiplier keeps growing), so the first fry result ends the search.
- `minItemsForBatch(effectiveBatch, arch)` — the inverse: how many files before a given batch is
  safe. Bounded scan to 2000, returns null if never.
- `suggestSteps()` returns `batchCeiling` and `overBatched`, and the explanation string now names
  the ceiling for the actual file count and the files the requested batch would need. The old
  floor warning still fires independently — it covers the case no batch choice can fix.

**Measured thresholds for effective batch 4** (from the real functions, not estimated):

| arch | batch 2 safe from | batch 4 safe from |
|---|---|---|
| SDXL / Illustrious-XL | 15 files | 29 files |
| Anima 2B | 16 files | 32 files |
| FLUX.2 Klein 4B / 9B | 20 files | 40 files |
| Krea 2 | 16 files | 45 files |

Across the operator's stated 20-150 range this means: at 20-30 files batch 4 is fry on every one
of their archs and the advisor now says so with the number; from ~45 files up it is healthy
everywhere; and at 100-150 files batch 1 has gone *cool* (ceiling-bound and undertrained) on
Klein and Anima, so the ceiling is also the answer to "why is my big dataset not learning".

**Recipes are now tier-aware** rather than pinned at 2: `sdxl`, the Illustrious branch of
`illustriousOrPonyRecipe`, and `anima` offer batch 4 on the `large` tier (150+) and 2 below it.
Anima's `large`-tier suggestion therefore reproduces the model author's published effective
batch 4 exactly; below that tier the deviation and its reason are still stated in the notes.
Pony, flux, krea2, zimage and klein recipes were already batch 1-2 and are unchanged.

**Presets.** `anima_lora_performance` (v3.0) and `anima_lora_5090_fast` (v2.0) — the two 32 GB
desktop profiles, i.e. exactly the high-VRAM tier this change exists for — move to batch 4 /
accum 1, with the >=32 file requirement and the fallback preset named in their descriptions.
The laptop and background profiles stay at effective batch 2 deliberately: they are the
low-VRAM tier, and batch 4 would not fit regardless of dataset size.

**Also delivered in this pass** (same session, separate concerns):
- `presets/flux2_klein_9b_{character,style}_lora.json` — the 9B tier existed only as two
  hand-edit instructions buried in the 4B preset's description. Now real presets.
- `presets/{flux2_klein_character_lora,illustriousxl_character_lora,anima_lora}_automagic.json`
  — automagic3 variants carrying the `min_lr`/`max_lr` rail pattern proven on
  `krea2_lora_16gb` (`max_lr` = the preset's own launch LR, so the controller only adapts
  downward). All three pin `gradient_accumulation: 1`: fused Automagic steps every micro-batch
  and `TrainConfig` hard-errors on the combination. Flagged UNVERIFIED per arch — the
  2026-07-19 finding still holds, Krea 2 remains the only arch with a measured automagic3 run,
  and a re-check of the web this session found no new community data (and no change to
  `automagic3.py` upstream since `cfdc903`, 2026-07-17).

**Test harness.** The contract suites could previously only import leaf modules with no relative
imports, because bare Node's ESM resolver requires file extensions and the app source uses
Next-style extensionless specifiers — `stepSuggestion.ts` was untestable for that reason alone.
Added `ui/tests/tsResolve.mjs` + `ui/tests/register.mjs` (a resolve hook, no npm dependency) and
wired them into the `test` script. Seven new cases, including a 10,800-combination sweep across
arch x itemCount x batch asserting `overBatched` is true for every fry-band result, except the
irreducible case (<=9 files, ceiling already 1, nothing left to lower). That sweep is the
regression guard for the original bug — it is what will catch a future edit to the bands, the
floors, `roundTo50`, or the ladder reintroducing it.

**Verified:** 39 Node contract tests pass (32 baseline + 7 new). All 27 presets parse and are
accepted by the Automagic/accumulation guard block executed verbatim out of
`toolkit/config_modules.py`. No preset exceeds effective batch 4. Not covered here: `tsc`,
`next build` and the Python suites need dependencies absent from this container — run them on
the Windows box before relying on the UI build.

## Bug sweep from the tracker audit (2026-08-29)

A full read of PLAN.md, FORK_NOTES.md and every fork-only file produced 13 bugs (tracker
AIO.1–13). All are fixed here except AIO.13, which turned out not to be one. Every change is
in fork-only files; the upstream merge surface is still 57 files.

**AIO.1 — Z-Image presets trained the distilled Turbo weights without the adapter.** All
three `presets/zimage_*_lora.json` set `name_or_path: Tongyi-MAI/Z-Image-Turbo` with
`arch: zimage`. In `options.tsx` the base `zimage` arch defaults to `Tongyi-MAI/Z-Image`;
`zimage:turbo` is the arch that pairs the Turbo weights with
`model.assistant_lora_path` = Ostris' training adapter. The presets' own descriptions
("Sample settings assume the distilled Turbo, CFG 1, 8 steps") show the Turbo intent, so the
fix is the arch + adapter, not the weights: v1.1 sets `arch: zimage:turbo` and the adapter
path, and says how to get base Z-Image instead. The trainer strips the `:variant`
(`toolkit/config_modules.py`), so the arch string is valid trainer-side. `presets/README.md`
and `docs/preset_alignment_2026_07.md` updated.

**AIO.2 — the QoL CLIs scanned a flat folder while the trainer walks subfolders.**
`preflight.py`, `auto_caption.py`, `smart_prep.py` all used `folder.iterdir()` and skipped
directories; `toolkit/dataset_selection.py` (what the trainer enumerates) walks recursively.
On a dataset organised into child folders — which `DatasetFolderPickerModal` encourages —
pre-flight hard-errored "no images found" and the other two silently did nothing. New
`scripts/qol_common.py` delegates discovery to `list_dataset_media_files` itself (not a
fourth copy of the walk), reports files by relative path, and absorbs the duplicated
torch-CUDA-DLL shim. `smart_prep` mirrors the source's subfolder layout under `out_dir`.
`testing/test_qol_scripts.py` (15 cases) pins nested discovery, pruning, report semantics,
`looks_like_local_path`, caption selection and prep planning/resume.

**AIO.3 — `BUILTIN_PRESET_NAMES` was five presets behind.** Moved to a dependency-free
`ui/src/server/builtinPresets.ts`; `ui/tests/builtinPresets.test.mjs` asserts it equals the
files in `presets/`, so the list can no longer drift silently. The presets POST route now
refuses to overwrite any existing preset without `overwrite: true`; only the dialog's
confirmed Overwrite button sends it (the built-in guard was client-only before, and
"Save as new" over an existing name silently replaced it).

**AIO.4 — preset read route truncated lines at `//`, including inside `https://` strings.**
`ui/src/utils/jsonc.ts` is a string-aware stripper (tested); applied to `.json` and `.jsonc`.

**AIO.5 / AIO.6 — Dataset Tools API + run lifecycle.** Malformed JSON is a 400 (was an
unhandled 500 shown as "Failed to start"); GET with no parameters is a 400 (was
`200 {run:null}`); `buckets` is validated for multiples-of-64 / MIN≤MAX server-side (was an
argparse trace in the log pane); an existing prep output folder is a 409 unless
`options.resume` — a typo naming another dataset used to merge into it silently, and the
modal now has an "Allow existing output" checkbox for the legitimate resume case. A prep
run now locks its output dataset as well as its source (`RegisteredRun.locks`,
`findRunningWriter`), there is a DELETE cancel endpoint + Cancel button (status
`cancelled` once the child exits), and running children are killed on a clean process
exit. The POST returns the sanitized `outputName` and the modal shows it. **Not done, by
decision:** persisting the run registry across restarts — fork rule 2 rules out a table,
and a file-backed registry is more machinery than a one-hour log retention justifies. The
limit (a hard `taskkill /F` skips the exit hook) is documented in FORK_NOTES.md.

**AIO.7 — advisor panel vanished on a failed count.** A `-1` count is now reported with a
Retry instead of falling through to `suggestSteps() → null`; a failed analysis is listed
inside the panel. The count/analysis caches expire after 60 s and have ↻ / Re-analyze
controls (they used to live for the page lifetime).

**AIO.8 — prefix-inherited recipes showed FLUX.1 numbers for FLUX.2 dev with no caveat.**
`getArchRecipe` now marks a prefix hit (`inheritedFrom`) and prefixes the notes with
"INHERITED FROM '<base>' … unverified"; the component renders the flag. Exact keys, the
`flex`/`chroma` aliases, and `:variant` archs (`zimage:turbo`, `krea2:turbo` — resolved to
their base as exact matches, as the trainer does) are not flagged.

**AIO.9 — per-image math rendered for video/audio archs; dead `sd3` heuristic.** The
component reads the arch `group` from `options.tsx` and shows a one-line "image models
only" note for `video`/`audio`. `sd3` removed. `suggestSteps` reports `heuristicSource`
(`arch`/`prefix`/`default`) and the explanation says "generic default" or "inherited from
'<key>'" so a 75/file guess no longer reads like a researched number.

**AIO.10 — flat exposure target over-warned on large sets.** The self-contradiction was
the actual bug: the advisor suggests the `maxSteps` ceiling for a large set and its own
gauge banded that number "cool — likely undertrained". `exposureGauge` now sets
`ceilingBound` when a cool reading exists only because the ceiling binds at this size, and
the label says so ("large sets usually converge at fewer passes; trust sample grids") rather
than asserting undertraining nobody measured. The band stays `cool` — exposure really is
below the flat target — and the 10,800-combo sweep is untouched. **Deliberately not done:**
a per-arch tiered target like krea2's. That needs a measured run per arch (the honesty
rule); tracker AIO.10 stays open for that half, re-scoped.

**AIO.11 — docs drift.** `docs/profiles.md` no longer claims every arch ships two profiles
(only Anima does). The batch-4 thresholds `presets/README.md` quotes are now pinned by a
test against `minItemsForBatch`, so they fail `npm test` instead of drifting.

**AIO.12 — `.claude/launch.json` started the UI on port 3000**, which `stop.bat` cannot
stop (it matches `--port 8675`). Now passes `--port 8675`. Stale PID-pinned permission
rules pruned from `.claude/settings.local.json` (gitignored).

**AIO.13 — `useJobsList` "double poll": not a bug.** The paired requests come from two
legitimate consumers of the same query on the dashboard — Sidebar's `ActiveJobWidget`
(`onlyActive`) and `dashboard/page.tsx`'s `<JobsTable onlyActive />` — each polling every
5 s via `usePollLoop`, whose cleanup is correct under StrictMode. Deduplicating them would
touch four upstream files for one SQLite query per 5 s. Closed won't-do.

**Verified:** `npm test` 55/55 (39 → 55: +7 registry/provenance/gauge/README cases, +5
JSONC, +2 built-in presets, +2 tool-run locks), `tsc --noEmit` clean, `next build` exit 0,
Python 31/31 (`test_qol_scripts` 15 new + the four existing suites), `py_compile` on every
touched script. `git diff upstream/main --name-status | grep -v '^A'` = 57, unchanged. Not
covered: the tools run end-to-end (needs the WD14/U2Net downloads) and the advisor panel
visually — both are runtime-only.

## Performance pass (2026-08-29)

A read of the training hot path and the UI/server/worker for headroom, after the bug
sweep above. Tracker AIO.45–51. Two findings changed the picture more than any code:

**Two speed claims in FORK_NOTES were stale.** (a) "`torch.compile` — Windows/Triton
viability question": upstream ships a complete implementation (`ModelConfig.compile`,
`block_compile`, `compile_mode`, `compile_fullgraph`, `compile_dynamic`; per-block compile,
auto dynamo cache sizing and rollback-on-failure in `jobs/process/BaseSDTrainProcess.py`
~2288-2482, upstream `089e41d`) and the repo `.venv` carries `triton_windows 3.7.1.post27`
on torch 2.9.1+cu128. Not one preset enabled it. (b) "`num_workers` hardcoded to 0 on
Windows": upstream reads `dataset.num_workers` (default 2) / `prefetch_factor` and sets
`persistent_workers` (`toolkit/data_loader.py` ~730-738). Both corrected in FORK_NOTES.

**The fork had built its levers and then not applied them.** `cache_latents: true` (RAM-served
latents) was documented as essential — disk-only caching drops `_encoded_latent` in
`cleanup_latent()` and re-does `safetensors.load_file` + uint8→float rehydration per item
per step in `get_latent()` (`toolkit/dataloader_mixins.py` ~1859-1906) — yet 21 of 27 presets
set only `cache_latents_to_disk`; the laptop tier had the fast path and the desktop presets
did not, and `krea2_lora_16gb` cached nowhere (VAE re-encode every epoch). `loss_sync_every`
was in one preset; `ui_db_poll_seconds` in six, so the UI trainer opened five sqlite
connections per step (`DiffusionTrainer.py` ~372-386: one write + four reads, each a fresh
`sqlite3.connect`) for every other job. **Change:** every preset except `anima_lora_5090_fast`
(already had all three) now sets `cache_latents: true` (+ `cache_latents_to_disk` where it
was off), `loss_sync_every: 4`, `ui_db_poll_seconds: 2`; versions bumped, descriptions say so.
Config defaults stay upstream's, so hand-written configs are untouched. All 27 presets parse
through `TrainConfig`/`DatasetConfig`/`ModelConfig`/`NetworkConfig`. The `_5090_fast` example
yaml said `batch_size: 2` while the v2.0 preset says 4 — yaml corrected.

**UI/server (fork-only):** cron worker queue scan 1 s → 2 s (`AI_TOOLKIT_QUEUE_POLL_MS`);
it was 5–9 Prisma round-trips per second against the file the trainer writes each step, and
nothing in it needs sub-second latency. Dataset Tools log polling shipped the whole (≤200 KB)
buffer every second and re-sliced a 150 KB string per stdout chunk — now a chunked
`LogBuffer` plus the `?offset=` incremental contract the job-log route already uses. Peer
probes ran on the GPU list's 5 s cadence with up to a 6 s timeout per offline peer — now
≥30 s client-side and a 30 s server TTL (POST still invalidates).

**`torch.compile` on the 5090 — NOT measured.** A bench series (`anima_lora_5090_fast`
baseline vs `compile: true` + `block_compile: true`, 20-image set, 200 steps) was started
and stopped at the operator's request before the pre-warm finished; no row was written and
`docs/speed_benchmarks.md` still does not exist. No compile preset ships until it is
measured (AIO.46). The bench configs are two lines on top of the fast preset:
`model.compile: true`, `model.block_compile: true`; keep `compile_dynamic` at its default
`true` for a bucketed resolution list.

## Dataset-size-aware exposure target (2026-08-29) — closes the 2026-07-29 deferral

The other half of AIO.10. The 2026-07-29 entry above documented that every fixed steps/item
target over-warns on large datasets and named the fix — "make the exposure target
dataset-size-aware ... a larger change to shared gauge logic deferred for now". Implemented
now, as the *shared* mechanism that entry described rather than as invented per-arch numbers.

**The curve, and why it is not a guess.** `sizeTargetScale(n)` damps a flat target by
`(65/n)^(1/3)`, clamped to at most 1. The exponent is not chosen for looks: krea2 is the one
arch in this repo with a measured + published triple (45 steps/item at ~20 images, 32 at ~60
— MEASURED on a documented 36-image run, 20 at ~250 from published 100-500 image recipes),
and those three points fit a power law with exponent -0.32. Applying the resulting curve to
krea2's own *measured* anchor predicts 20.4 steps/item at 250 images against its *published*
20 — that agreement is the entire evidence base, and it is pinned by a test so a future edit
to the exponent or anchor has to keep reproducing it. The anchor (65) is the geometric middle
of the `medium` band (30-149), which is the dataset size the community guides these flat
numbers came from are actually written for.

**Two limits keep it honest.**
1. **It only ever damps.** Below 65 images the scale is exactly 1, so every existing
   recommendation for a small or medium set is byte-identical to before — this change cannot
   raise a suggestion into overfit range, only lower an inflated target on a big set. It also
   means the batch-4 file thresholds (29 SDXL / 32 Anima / 40 Klein / 45 Krea 2 — all under
   the anchor) cannot drift, which `presets/README.md` and the ladder tests both quote.
2. **Measured beats derived.** krea2 keeps its own tier function and is exempt from the
   curve; compounding the two would double-count the size effect.

**What this does not claim.** A 250-image SDXL set now measures against 64 steps/item instead
of 100 — better sourced than the flat number, but still not a measurement for *that* arch at
*that* size. And past a certain size it is the `maxSteps` ceiling, not the target, that binds;
raising it needs its own evidence and is still deliberately not guessed. `ceilingBound` (added
earlier the same day) is what keeps the gauge from calling the advisor's own recommendation
"undertrained" in that region. Per-arch measured tiers remain the ideal and remain untaken.

**Verified:** 62 Node tests (55 + 7 new), including the krea2 corroboration, monotonicity of
the scale over 1-4000 items, "no small/medium advice moved", the unchanged batch thresholds,
and the pre-existing 10,800-combination sweep asserting the `overBatched` flag never disagrees
with the gauge — the regression guard for the original 2026-07-29 bug — still green.

## Sync automation + test coverage (2026-08-29)

The rest of the tracker's actionable non-GPU work (AIO.16, 18–21, 25). Every sync log entry
in FORK_NOTES had been re-deriving the same checks by hand; they are now scripts, and the
two "one-off manual audit" claims in this file are now tests.

**`scripts/verify_fork.py` (AIO.18)** — the post-merge tripwire. Five checks: 34 insertion
anchors across the upstream files the fork modifies (plus the Modal `backdrop-blur` removal,
matched with comments stripped so the comment explaining that removal doesn't read as a
relapse); the modified-upstream-file count against `EXPECTED_TOUCHPOINTS` (57), **skipped
rather than failed while the fork is behind upstream** because the count is meaningless
mid-sync (CLAUDE.md's warning); every App Router `params` still the Next 15 `Promise<...>`
shape (upstream keeps shipping the Next 14 one — it recurred on 2026-08-23); the `comm -12`
doc-key overlap that bit on 2026-08-11; and `BUILTIN_PRESET_NAMES` against `presets/`.
Verified by negative control: removing the `forkDocs` reference from `docs.tsx` fails the
insertions check with the right message.

**`scripts/run_fork_tests.ps1` (AIO.20)** — one command for the whole checklist: the
tripwire, six Python suites (with `PYTHONPATH` and the repo `.venv` — they are bare
`unittest` scripts because the venv has no pytest), `py_compile` on the fork scripts, then
`npm test` / `tsc --noEmit` / worker `tsc` / `next build`. A missing `.venv`, missing torch
or missing `node_modules` is reported as **SKIP with a reason, never as a pass**, and the
summary prints what was not covered — which is what a sync report needs to state honestly.
All 12 gates pass on this box.

**`testing/test_presets.py` (AIO.21)** — PLAN recorded "all N presets parse through
`TrainConfig`" and "accepted by the Automagic guard" as manual audits at 17, 21 and 27
presets; nothing re-ran them. Now a test: every preset constructs through
`TrainConfig`/`DatasetConfig`/`ModelConfig`/`NetworkConfig`, effective batch ≤ 4, every arch
exists in `options.tsx`, and no preset uses weights that are *another* arch's registry
default. That last check is the AIO.1 shape, and it was validated by reverting the Z-Image
preset to the broken pair and watching it fail. It deliberately allows an arch pointed at a
non-registry checkpoint — that is exactly how the Illustrious/Pony presets work on `sdxl`,
and a first draft that required an exact registry match flagged all four of them as false
positives.

**`.gitattributes` + `scripts/restore_ui_pkg.ps1` (AIO.19)** — `.gitignore merge=union`
turns the conflict that happened on nearly every sync into an automatic keep-both (verified
on a synthetic tail conflict in a scratch repo). A removal from `.gitignore` still needs its
own commit; union merge cannot express a deletion. The package restore script takes
upstream's `package.json`/lockfile, re-applies the fork's single `test` line, and verifies
the lockfile hash — it refuses and asks if upstream ever defines its own `test` script.

**`start-rebuild.bat` (AIO.16)** — when an update touches `requirements*.txt` it now offers
(`choice`, 30s timeout, **defaulting to No** so an unattended rebuild never touches the
venv) to run `pip install -r requirements.txt`. It previously only printed a reminder, and
the venv could silently drift from the pinned diffusers commit.

**Housekeeping (AIO.25)** — the Node 22 `--experimental-strip-types` flag is dropped from
`ui/package.json`'s test script (the box runs Node 25; native type stripping since 23). The
stale `.codex/lds-upstream-sync-temp` tree from 2026-08-17 has ACLs git cannot stat, so
every `git status` printed permission warnings and `rm -rf` could not remove it; `.codex` is
now in `.gitignore`, which stops git descending into it — warnings gone. The DLL-shim
duplication was already fixed by `scripts/qol_common.py` in the earlier sweep. QuickEdit
Mode stays the operator's own registry setting (PLAN 2026-07-17); the offer stands.

**Verified:** `scripts/run_fork_tests.ps1` — 12/12 gates PASS (verify_fork, 6 Python suites,
py_compile, npm test 55/55, `tsc`, worker `tsc`, `next build`). Not covered, as always: the
cron worker's runtime paths, a real training run, and the Dataset Tools CLIs end-to-end.

**Filed, not done:** the remaining config-only levers each need one measured run before a
preset ships them (AIO.47: fused AdamW on the non-quantized anima presets via
`optimizer_params`, `gradient_checkpointing: false` on `anima_lora_performance`,
`layer_offloading_transformer_percent` < 1 on the krea2 offload presets,
`cache_text_embeddings` on non-anima presets, sample/save cadence, explicit `num_workers`);
the one remaining unconditional per-step host sync (`additional_model_loss.item()`,
`SDTrainer.py` ~1070) and the per-accumulation `empty_cache()` on multi-resolution `low_vram`
runs, both upstream insertions (AIO.48); and the upstream-owned UI polling hotspots — the
uncached `/api/jobs` full list with every `job_config`, the job page's six loops running at
full rate on finished jobs, hot-path `console.log`s, the 500 ms monitor tick, unshared
`useJobsList`/`useSettings` (AIO.50) — each a touchpoint decision. mtime-keyed server caching
of count/analyze is an idea with real caveats (AIO.51).
