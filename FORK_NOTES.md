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
| `ui/src/app/jobs/new/SimpleJob.tsx` | +1 import, +1 JSX line mounting `<StepSuggestion/>` as a full-width sibling AFTER the Training card's column grid (moved out of column 1, 2026-07-19); +1 import, +1 JSX line mounting `<OptimizerHint/>` directly under the Optimizer `SelectInput`; +1 import and +1 JSX line mounting `<DatasetFolderPickerModal/>` next to `<AddSingleImageModal/>`; +1 small block under the "Target Dataset" `SelectInput` showing the resolved current path + a "Browse subfolders…" button (see PLAN.md's dataset-folder-browser entry, 2026-07-19) | Re-add the StepSuggestion mount after the `trainingBarClass` grid inside the Training Card; re-add the OptimizerHint mount below the Optimizer select; re-add the DatasetFolderPickerModal mount alongside AddSingleImageModal; re-add the path/browse block directly under the Target Dataset SelectInput if upstream restructures the dataset row |
| `ui/cron/actions/startJob.ts` | Rewrote `startAndWatchJob` from an async-executor `new Promise` to a plain `async function` with the whole body in one try/catch (`markJobError` helper), and made the fire-and-forget call site (`startJob()`) attach `.catch()`. Fixes a WORKER-process crash: any exception in the unprotected setup code (DB reads, `fs.mkdirSync`/`writeFileSync`) became an unhandled promise rejection that Node treats as fatal, and `concurrently`'s infinite auto-restart turned that into a crash-restart loop that looks like a frozen console — see PLAN.md "Fix: WORKER process crash on job-launch errors (2026-07-17)" | If upstream rewrites this function, re-apply the try/catch restructuring rather than reverting to an async-executor Promise |
| `ui/cron/worker.ts` | +2 top-level `process.on('unhandledRejection'/'uncaughtException', ...)` handlers that log and keep the process alive, added right after the import | Re-add near the top of the file if upstream restructures it; this is a safety net for the same crash-loop class of bug, not a substitute for fixing the specific cause |
(The fork previously also modified `extensions_built_in/diffusion_models/__init__.py`,
`ui/src/app/jobs/new/options.ts`, and owned `extensions_built_in/diffusion_models/anima/`
for the Phase 4 Anima port. Upstream shipped its own Anima support (ostris#860), so on
2026-07-16 the fork's port was sunset and those three are now byte-identical to
upstream — see PLAN.md Phase 4 for the history. The fork's Anima *enhancements* live on
in fork-only files: the presets, the example config, and the advisor recipe.)

## Fork-only files (never conflict)

- `PLAN.md`, `FORK_NOTES.md`
- `ANIMA_INTEGRATION_SPEC.md` — spec for Anima 2B model port + TrainFlow QoL consolidation (COMPLETE; kept as the requirements record, see its status banner)
- `docs/anima_delta_catalog.md` — A1 recon artifact: Anima 2B architecture/training-math/LoRA-key catalog + ai-toolkit port mapping (key finding: Anima support is native upstream kohya sd-scripts v0.10.5, not TrainFlow-authored)
- `scripts/dump_lora_keys.py` — A3 helper: dump or diff LoRA safetensors keys+shapes (exit 0 only on zero mismatch). Outlived the fork's Anima port (sunset 2026-07-16) — still useful for checking any LoRA's key format
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
- `stop.bat` — killswitch companion to `start.bat`: stops the UI (port 8675) + cron worker even when the launching terminal is gone/frozen, matched by command-line signature so it never touches unrelated node/python. Leaves detached training alone by default; `stop.bat all` also stops a running `run.py` training
- `presets/` — preset config files (drop-in JSON/YAML). 2026-07-19: seven LDS-ported presets added (zimage char/style/concept, flux2_klein char/style, krea2 concept, sdxl concept) + `flux_lora_24gb.json` v1.1 EMA fidelity fix; provenance table in `presets/README.md`, comparison in `docs/preset_alignment_2026_07.md` (fork-only)
- `ui/src/server/presetsPath.ts`
- `ui/src/server/datasetFiles.ts`
- `ui/src/server/imageSize.ts` — header-only image dimension reader (png/jpg/webp)
- `ui/src/app/api/presets/route.ts`
- `ui/src/app/api/presets/[name]/route.ts`
- `ui/src/app/api/datasets/count/route.ts` — accepts an optional `subPath` (resolved via
  `resolveDatasetSubPath`, datasetFiles.ts) to scope the count to a subfolder instead of
  the whole top-level dataset, so it matches what a nested folder-browser selection will
  actually train on (2026-07-19, see PLAN.md)
- `ui/src/app/api/datasets/analyze/route.ts` — dimension histogram + caption coverage;
  same optional `subPath` scoping as `count/route.ts`
- `ui/src/app/api/datasets/browse/route.ts` — non-recursive per-level folder listing +
  breadcrumbs for a dataset (or a subfolder within it), used by the folder-browser modal
  so a job can target a nested folder (e.g. `Dataset/Folder 1/Folder 1a`) instead of only
  a top-level dataset (2026-07-19, see PLAN.md). `datasetName` is validated via
  `sanitizeDatasetName` (datasetFiles.ts) before use, not `path.basename()` alone —
  see the Duplication watch entry below, this matters for `count`/`analyze` too
- `ui/src/components/DatasetFolderPickerModal.tsx` — breadcrumb folder-browser modal
  (global-state, mirrors `AddSingleImageModal.tsx`'s open.../use() convention)
- `ui/src/utils/presets.ts`
- `ui/src/utils/stepSuggestion.ts` — step heuristics + exposure gauge + bucket analysis + arch recipes
  (dataset-size-tiered rank/LR/scheduler, Illustrious/Pony detected by checkpoint name since they
  share `arch: "sdxl"` with vanilla SDXL — see the researched-recipe writeup in conversation history
  for source confidence per number; several values are flagged low-confidence/contested in the notes)
- `ui/src/utils/buckets.ts` — TS port of `toolkit/buckets.py::get_bucket_for_image_size`
- `ui/src/components/OptimizerHint.tsx` — inline guidance under the Optimizer select,
  shown only for the Automagic family: v1/v2 get a "superseded by v3" note + one-click
  switch; v3 explains that LR is a launch point (self-adapting, no scheduler) and offers
  a state-aware "Bound it" button that sets `optimizer_params.min_lr`/`max_lr` (which
  have no UI field anywhere else, like `lr_scheduler`). Guidance sourced from the
  optimizer author's docstrings — see PLAN.md's Automagic v3 research entry
- `ui/src/components/PresetManager.tsx`
- `ui/src/components/StepSuggestion.tsx` — step suggestion + dataset analyzer panel.
  Derives the dataset name/subPath to query via `deriveDatasetSelection`, which needs
  `DATASETS_FOLDER` (fetched with `useSettings()`) to split `folder_path` correctly for
  nested selections — see the Duplication watch entry on `resolveDatasetSubPath` below

## Duplication watch (re-check after each upstream merge)

- `ui/src/server/datasetFiles.ts` duplicates the media-extension whitelist and `_controls`
  exclusion from `ui/src/app/api/datasets/listImages/route.ts` (route files can't export
  helpers). If upstream changes that list, mirror it.
- `sanitizeDatasetName` (`datasetFiles.ts`) is the required validator for any route that
  joins a client-supplied `datasetName` onto the datasets root — `path.basename()` alone
  does NOT stop traversal (`path.basename('..')` returns `'..'` unchanged, letting
  `path.join(datasetsRoot, '..')` escape the root entirely; confirmed via a live curl
  test 2026-07-19, see PLAN.md). All three current consumers (`count`, `analyze`,
  `browse` routes) use it — any new dataset route accepting `datasetName` must too.
- `resolveDatasetSubPath` (`datasetFiles.ts`) is the required resolver for any route that
  scopes an operation to a nested folder within a dataset via an optional `subPath` —
  `count`, `analyze`, and `browse` all use it; any new such route must too, rather than
  reimplementing the segment-filter + traversal-guard logic inline again.
- `deriveDatasetSelection` (`StepSuggestion.tsx`) must split `folder_path` the same way
  `resolveDatasetSubPath`/the browse-modal's path construction agree on (first segment
  after `DATASETS_FOLDER` = dataset name, everything after = subPath). If the datasets
  root or the folder-browser's path-joining convention ever changes, update this too —
  a top-level-only assumption here previously made the whole step-suggestion panel
  disappear for nested selections (2026-07-19, see PLAN.md).
- `ui/src/utils/presets.ts` mirrors the "set required fields" logic from the import flow in
  `ui/src/app/jobs/new/page.tsx` (`sqlite_db_path`, `training_folder`, `device`,
  `performance_log_every`). If upstream adds a required field there, add it here too.
- `ui/src/utils/buckets.ts` is a port of `toolkit/buckets.py::get_bucket_for_image_size`
  (divisibility = dataset `bucket_tolerance`, default 64 in `toolkit/config_modules.py`).
  If upstream changes the bucketing math, re-port it or the analyzer's bucket predictions
  drift from what the trainer actually builds.
- `ui/src/server/imageSize.ts` must cover the same image-extension whitelist as
  `datasetFiles.ts` (currently png/jpg/jpeg/webp).
