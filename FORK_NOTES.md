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
| `toolkit/config_modules.py` | +1 commented block in `TrainConfig.__init__` directly after `cache_text_embeddings`, adding the fork speed keys (`loss_sync_every` default 1, `ui_db_poll_seconds` default 0.0 — both defaults = upstream behavior) | Re-add the block anywhere in `TrainConfig.__init__`; keys are read via `kwargs.get` so position is cosmetic |
| `extensions_built_in/sd_trainer/SDTrainer.py` | Speed opt, all gated on `train.loss_sync_every > 1` (default 1 = byte-for-byte upstream behavior): +1 import (`toolkit.fork_speed`), the NaN-loss guard gains a gated `torch.nan_to_num` branch ahead of upstream's `torch.isnan` check, and the `loss_dict` build at the end of `hook_train_loop` gains a gated `DeferredLossTracker` branch ahead of upstream's per-step `.item()` | Three small insertions in two functions (`train_single_accumulation` NaN check, `hook_train_loop` loss_dict). If upstream restructures, re-apply: gate = `self.train_config.loss_sync_every > 1`; on the gated path replace `torch.isnan`-check with `torch.nan_to_num(loss)` and the `.item()` with `DeferredLossTracker.push()` (lazy-init via `getattr`, no `__init__` touch) |
| `extensions_built_in/sd_trainer/DiffusionTrainer.py` | Speed opt, gated on `train.ui_db_poll_seconds > 0` (default 0 = upstream behavior): one insertion at the top of the `is_ui_trainer` branch of `end_step_hook`, rate-limiting the per-step sqlite work (upstream does 4 blocking SELECTs — stop/return-to-queue/save-now/sample-now, each on a fresh connection — plus the async step write, every step, on the training thread) | Re-apply as an early-`return` time gate (`time.time()` vs `_fork_last_db_poll`, lazy via `getattr`) before `update_step()`/`maybe_stop()`/`maybe_save()`/`maybe_sample()` in `end_step_hook` only — do NOT throttle the other `maybe_stop()` call sites (model load/sample/save), they are rare. UI stop/save/sample buttons take up to `ui_db_poll_seconds` to be noticed when enabled. Legacy `UITrainer.py` (uid `ui_trainer`) deliberately untouched |
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
- `toolkit/fork_speed.py` — speed-optimization helpers (`DeferredLossTracker`: on-device loss accumulation, host sync every N steps). Keeps the gated hot-loop insertions in upstream files tiny — see the Speed optimization section below
- `scripts/bench_speed.py` — speed-benchmark harness: runs a config for a fixed step count (sampling disabled, saves out of range), measures end-to-end steps/s from `performance_log_every` timer markers, polls nvidia-smi for peak VRAM, appends a markdown row to `docs/speed_benchmarks.md` (created on first run, also fork-only)
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
- `config/examples/train_lora_anima_2b_5090_fast.yaml` — speed-optimized variant (Phase 6): checkpointing off, RAM-served latents, fork speed keys
- `presets/anima_lora_performance.json`, `presets/anima_lora_background.json`
- `presets/anima_lora_5090_fast.json` — the Phase 6 fast profile (see PLAN.md Phase 6 + the Speed optimization section below)
- `ui/src/utils/stepSuggestion.ts` also carries the Anima recipe in `ARCH_RECIPES` (fork file, listed above)
- `start.bat` — double-click launcher for the UI (`start.bat rebuild` after pulling upstream). No longer auto-opens a browser tab on launch (2026-07-20) — `create_shortcut.bat` below is the intended entry point for click-to-open use
- `stop.bat` — killswitch companion to `start.bat`: stops the UI (port 8675) + cron worker even when the launching terminal is gone/frozen, matched by command-line signature so it never touches unrelated node/python. Leaves detached training alone by default; `stop.bat all` also stops a running `run.py` training
- `create_shortcut.bat` — one-time setup script that creates a desktop `.lnk` targeting `start.bat`, using the UI's favicon as its icon (instead of a bare `.bat` file on the desktop). Run once; the resulting shortcut is the day-to-day launcher (2026-07-20)
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

## Speed optimization (Phase 6, 2026-07-19)

Workstream to close the per-step gap with OneTrainer (design history: PLAN.md
Phase 6). Everything is config-gated; **all defaults preserve upstream behavior
byte-for-byte** — a config that doesn't set the fork keys trains exactly as
upstream would.

Fork config keys (both in `train:`):

| Key | Default (=upstream) | Enabled effect |
|---|---|---|
| `loss_sync_every` | `1` | N > 1: loss syncs device→host every N steps instead of every step (CPU stops waiting on the GPU each step; dataloading/logging overlap compute). Displayed/logged loss updates every N steps; NaN losses are neutralized on-device without the "loss is nan" print |
| `ui_db_poll_seconds` | `0` | > 0: the UI trainer's per-step sqlite work (4 blocking reads + 1 write) runs at most once per interval. UI stop/save-now/sample-now buttons take up to this many seconds to be noticed. CLI runs are unaffected either way |

Config-only levers (upstream keys, encoded in `presets/anima_lora_5090_fast.json`):
`gradient_checkpointing: false` (defaults **true** — the single biggest lever on
a small model), `cache_latents: true` **plus** `cache_latents_to_disk: true`
(disk-only caching re-reads + deep-copies every latent from disk every step;
both together = write once, serve from RAM), `cache_text_embeddings: true`
(also hard-unloads the TE — verified: swapped for a stub, not just
requires_grad(False)), `quantize: false` (verified zero-overhead when off),
stretched `sample_every`/`save_every`.

**Benchmark protocol** (`scripts/bench_speed.py`): fixed dataset + resolution
list + seed, 200 steps, first 20 discarded, mean steps/s of the rest measured
end-to-end from `performance_log_every` markers; peak VRAM via nvidia-smi; one
variable per run. Results append to `docs/speed_benchmarks.md`. This branch was
authored in a GPU-less environment — **numbers are pending operator runs on the
5090**. Run matrix, in order (re-run the first once to warm caches):

1. `baseline-stock` — `config/examples/train_lora_anima_2b.yaml` as-is
2. `no-checkpointing` — baseline + `gradient_checkpointing: false`
3. `ram-latents` — #2 + `cache_latents: true`
4. `loss-sync-4` — #3 + `loss_sync_every: 4`
5. `fast-profile` — `config/examples/train_lora_anima_2b_5090_fast.yaml` (adds batch 4)
6. OneTrainer, equivalent config, same dataset — the target line
7. `ui_db_poll_seconds` — UI-launched A/B (CLI runs never touch the job DB)

**Recommended profiles:** small-model (≤~4B, fits bf16 + activations in 32GB):
the fast preset — no checkpointing, no quantization, RAM latents, batch up to
VRAM. Large-model (quantized/offload path): keep `gradient_checkpointing: true`
and quantization; still apply both cache keys + `loss_sync_every` — those cost
no VRAM. Quality gate before trusting any code-path change: two 500-step runs
(same seed) pre/post, loss curves overlaid + fixed 4-prompt grids compared.

**Audited and deliberately NOT changed:** Windows `num_workers` hardcoded to 0
in `toolkit/data_loader.py` (dataset objects hold live model refs — Windows
spawn workers would need to pickle them; use WSL if the loader ever becomes the
measured bottleneck); `pin_memory` (no-op with the custom DTO collate); EMA
(already off by default); attention (already SDPA for Anima); the extra
per-step sync in `get_avg_learning_rate()` (automagic-family only — not in the
Anima recipe); legacy `UITrainer.py`. **Deferred (Phase 3 stretch, needs
operator input):** fused backward + stochastic rounding for AdamW (automagic3
already has a fused path built in), `torch.compile` (Windows/Triton viability
question), dataloader prefetch rework.

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
