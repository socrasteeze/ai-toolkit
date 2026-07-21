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
`diffusion_models/__init__.py`, and `options.ts` are byte-identical to upstream again,
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
  *changed* — `DATASETS_FOLDER` moved from `D:\datasets\_style` to `D:\datasets`)
  configured datasets root, three levels deep: root count 2176, one level down
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

## Launcher QoL: drop start.bat auto-open, add create_shortcut.bat (2026-07-20)

`start.bat` used to auto-open a browser tab (`start "" "http://localhost:8675"`) on
every launch, including every `npm run start` restart under `concurrently`'s
auto-restart. That line is removed — a fresh tab on every crash-restart was noisy, not
useful. In its place, `create_shortcut.bat` (fork-only, run once) builds a desktop
`.lnk` that targets `start.bat` and uses the UI's own favicon as its icon, so the
day-to-day launch path is "double-click the desktop shortcut" rather than a bare `.bat`
file with no icon. `stop.bat` is unaffected. See `FORK_NOTES.md`'s fork-only file list.
