# Fork Notes

This fork (socrasteeze/ai-toolkit) adds personal-use features on top of upstream
(ostris/ai-toolkit). See `PLAN.md` for the design. This file is the authoritative list of
every place the fork diverges from upstream — keep it updated so upstream merges stay a
two-minute job.

## Sync procedure

```bash
git fetch upstream
git merge upstream/main
# resolve conflicts (expected only in files listed below), then:
git push origin main
```

## Upstream files modified (the entire merge surface)

| File | Change | Notes for conflict resolution |
|---|---|---|
| `ui/src/app/jobs/new/page.tsx` | +1 import, +1 JSX line mounting `<PresetManager/>` in the TopBar | Re-add the mount next to the "Import Config" button if upstream restructures the TopBar |
| `ui/src/app/datasets/[datasetName]/page.tsx` | +1 import, +1 JSX line mounting `<DatasetTools/>` in the TopBar after `<AutoCaptionButton/>` | Re-add next to the Auto Caption button if upstream restructures the TopBar |
| `ui/src/app/jobs/new/SimpleJob.tsx` | +1 import, +1 JSX line mounting `<StepSuggestion/>` under the Steps `NumberInput` | Re-add directly below the Steps field if upstream moves it |
| `extensions_built_in/diffusion_models/__init__.py` | +1 import (`from .anima import AnimaModel`), +1 entry in `AI_TOOLKIT_MODELS`. Upstream now has its OWN identical-looking lines for its own Anima (see below) — after a merge, make sure the file has exactly ONE AnimaModel import/entry (ours) | Re-add both lines if upstream reworks the registration list |
| `ui/src/app/jobs/new/options.ts` | +1 `modelArchs` entry (`name: 'anima'`), deliberately kept as the LAST entry before the `.sort(` call. Upstream now ships its own `name: 'anima'` entry near the top of the array — DELETE upstream's on every merge, keep ours | Re-append at the end of the array on conflict |
| `extensions_built_in/diffusion_models/anima/` | **Upstream collision (since upstream #860, merged 2026-07-16):** upstream added its own diffusers-based Anima in this same directory (`anima.py`, exporting `AnimaModel` + `AnimaPromptEmbeds` from the package `__init__.py`). We keep OUR sd-scripts-parity port and delete upstream's `anima.py` + their `__init__.py` re-exports on every merge. Upstream's `toolkit/prompt_utils.py` has a guarded `AnimaPromptEmbeds` loader path that imports from this package — it only triggers for embed caches written by upstream's implementation, so it stays as-is (dead code for us) | On merge: `git checkout --ours` the package `__init__.py`, `git rm` upstream's `anima.py`, dedupe the two registration files above |

## Fork-only files (never conflict)

- `PLAN.md`, `FORK_NOTES.md`
- `ANIMA_INTEGRATION_SPEC.md` — spec for Anima 2B model port + TrainFlow QoL consolidation (COMPLETE; kept as the requirements record, see its status banner)
- `docs/anima_delta_catalog.md` — A1 recon artifact: Anima 2B architecture/training-math/LoRA-key catalog + ai-toolkit port mapping (key finding: Anima support is native upstream kohya sd-scripts v0.10.5, not TrainFlow-authored)
- `extensions_built_in/diffusion_models/anima/` — Anima 2B model extension (Phase 4): vendored MiniTrainDIT + LLM adapter (`src/anima_transformer.py`), `AnimaModel` with sd-scripts LoRA key export (`anima_model.py`), preview pipeline (`src/pipeline.py`). **No longer conflict-free** — upstream added its own Anima in this directory; see the merge-surface table above
- `scripts/dump_lora_keys.py` — A3 helper: dump or diff LoRA safetensors keys+shapes (exit 0 only on zero mismatch)
- `docs/anima_a4_parity.md` — A4 gate artifact: matched-run loss-curve/sample comparison vs TrainFlow + Prodigy behavior check (PASS, with documented benign optimizer-construction differences)
- `docs/profiles.md` — performance/background profile explainer + Workstream C gate artifact (measured Anima background-preset VRAM: 30–33% steady, 43% peak of 32GB — PASS)
- `scripts/preflight.py` — B1 dataset pre-flight validator (bare folder or `--config job.yaml`; exit 1 on missing captions/corrupt images/bad paths, warnings for oversized/stray files, `--warn-only` override)
- `scripts/auto_caption.py` — B2 WD14 auto-captioner (wd-eva02-large-tagger-v3 via onnxruntime, HF auto-download, `--general-thresh/--char-thresh/--trigger-word/--overwrite`, multi-threaded, GPU w/ torch-bundled CUDA DLLs)
- `scripts/smart_prep.py` — B3 U2Net subject-aware bucket resize/crop (optional prep tool, non-destructive in→out, `--buckets MINxMAX`, u2net.onnx auto-download to `~/.cache/ai-toolkit/`)
- `scripts/requirements-qol.txt` — extra deps for B2/B3 (`onnxruntime-gpu`); deliberately NOT added to upstream `requirements.txt`
- `ui/src/server/datasetTools.ts` — B5: spawns the QoL CLIs as child processes (uses upstream's `ui/cron/pythonPath.ts` resolver), buffers logs in-memory for polling; deliberately NOT a Prisma job
- `ui/src/app/api/datasets/tools/route.ts` — B5: POST starts a preflight/caption/prep run for a dataset, GET polls by runId or datasetName
- `ui/src/components/DatasetTools.tsx` — B5: "Dataset Tools" TopBar button + modal on the dataset page (WD14 tagger options, smart-prep buckets/output, advisory pre-flight, live log). Pre-flight is advisory only — it never blocks job submission (decision recorded in PLAN.md)
- `config/examples/train_lora_anima_2b.yaml`
- `presets/anima_lora_performance.json`, `presets/anima_lora_background.json`
- `ui/src/utils/stepSuggestion.ts` also carries the Anima recipe in `ARCH_RECIPES` (fork file, listed above)
- `start.bat` — double-click launcher for the UI (`start.bat rebuild` after pulling upstream)
- `presets/` — preset config files (drop-in JSON/YAML)
- `ui/src/server/presetsPath.ts`
- `ui/src/server/datasetFiles.ts`
- `ui/src/server/imageSize.ts` — header-only image dimension reader (png/jpg/webp)
- `ui/src/app/api/presets/route.ts`
- `ui/src/app/api/presets/[name]/route.ts`
- `ui/src/app/api/datasets/count/route.ts`
- `ui/src/app/api/datasets/analyze/route.ts` — dimension histogram + caption coverage
- `ui/src/utils/presets.ts`
- `ui/src/utils/stepSuggestion.ts` — step heuristics + exposure gauge + bucket analysis + arch recipes
  (dataset-size-tiered rank/LR/scheduler, Illustrious/Pony detected by checkpoint name since they
  share `arch: "sdxl"` with vanilla SDXL — see the researched-recipe writeup in conversation history
  for source confidence per number; several values are flagged low-confidence/contested in the notes)
- `ui/src/utils/buckets.ts` — TS port of `toolkit/buckets.py::get_bucket_for_image_size`
- `ui/src/components/PresetManager.tsx`
- `ui/src/components/StepSuggestion.tsx` — step suggestion + dataset analyzer panel

## Duplication watch (re-check after each upstream merge)

- `ui/src/server/datasetFiles.ts` duplicates the media-extension whitelist and `_controls`
  exclusion from `ui/src/app/api/datasets/listImages/route.ts` (route files can't export
  helpers). If upstream changes that list, mirror it.
- `ui/src/utils/presets.ts` mirrors the "set required fields" logic from the import flow in
  `ui/src/app/jobs/new/page.tsx` (`sqlite_db_path`, `training_folder`, `device`,
  `performance_log_every`). If upstream adds a required field there, add it here too.
- `ui/src/utils/buckets.ts` is a port of `toolkit/buckets.py::get_bucket_for_image_size`
  (divisibility = dataset `bucket_tolerance`, default 64 in `toolkit/config_modules.py`).
  If upstream changes the bucketing math, re-port it or the analyzer's bucket predictions
  drift from what the trainer actually builds.
- `ui/src/server/imageSize.ts` must cover the same image-extension whitelist as
  `datasetFiles.ts` (currently png/jpg/jpeg/webp).
