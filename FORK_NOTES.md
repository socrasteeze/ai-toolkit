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

> **NEVER open a pull request as part of a sync, and never open one against
> `ostris/ai-toolkit`.** A sync ends at `git push origin main` — that is the whole
> delivery step. This fork's changes are personal (presets, `.bat` launchers, the
> advisor, the QoL scripts) and are never proposed upstream; a previous agent opened
> an upstream PR and put the user's personal config in front of the upstream
> maintainer. The mechanism to watch for: GitHub **defaults a PR's base to the parent
> repo** when a branch is pushed from a fork, so an unqualified "open a PR" targets
> `ostris/ai-toolkit`, not `socrasteeze/ai-toolkit`. `gh` and the API behave the same
> way. Don't create one.

**`ui/package.json` / `ui/package-lock.json` are deliberately kept byte-identical to
upstream** — the fork adds no npm dependencies (the QoL Python deps live in
`scripts/requirements-qol.txt`). A local `npm install` can still rewrite the lockfile as a
side effect (different npm versions write different optional-dep metadata, e.g. the `libc`
arrays npm 11+ emits and npm 10 does not). On any merge, resolve both files by just taking
upstream's:

```bash
git checkout upstream/main -- ui/package.json ui/package-lock.json
```

Then `npm ci` (not `npm install`) in `ui/` so the lockfile stays untouched.

## Upstream sync log

| Date | Window | Result | Clean-merge catch | Verification |
|---|---|---|---|---|
| 2026-08-12 | 13 commits, `cbf910a` through `742a4c8` | 8 adopted as-is, 5 adopted with divergence work, 0 rejected | New dataset ZIP route used `path.basename()` and accepted `..`; replaced with the shared validator plus a post-`realpath` containment check | UI/worker static checks, touched-Python compile, production build, HTTP boot smoke, divergence/hygiene scans: PASS. Contract suites: 27 Node + 7 Python passed, identical to baseline |

## Upstream files modified (the entire merge surface)

| File | Change | Notes for conflict resolution |
|---|---|---|
| `ui/src/app/jobs/new/page.tsx` | +1 import + JSX mount for `<PresetManager/>`; +1 import + JSX mount for `<HelpModeButton/>` in the TopBar (next to Presets, before Show Advanced); **remote execution (2026-08-04)**: the `useGPUInfo` import/call is replaced by fork-only `useMachines` (which wraps it), the advanced-view GPU `SelectInput`'s inline `gpuList.map(...)` becomes `options={gpuOptions as any}`, and `gpuOptions={gpuOptions}` is passed down to `<SimpleJob/>` | Re-add both mounts in the TopBar button cluster if upstream restructures it — Presets then Help, before Show Advanced / Create Job. For the GPU picker: `useMachines` returns `gpuList` and `isGPUInfoLoaded` with upstream's exact meanings, so a conflict is resolved by keeping upstream's usage and only swapping the hook name back in, plus the `options`/`gpuOptions` lines |
| `ui/src/app/datasets/[datasetName]/page.tsx` | +1 import, +1 JSX line mounting `<DatasetTools/>` in the TopBar after `<AutoCaptionButton/>` | Re-add next to the Auto Caption button if upstream restructures the TopBar |
| `ui/src/app/jobs/new/SimpleJob.tsx` | +1 import, +1 JSX line mounting `<StepSuggestion/>` as a full-width sibling AFTER the Training card's column grid (moved out of column 1, 2026-07-19); +1 import, +1 JSX line mounting `<OptimizerHint/>` directly under the Optimizer `SelectInput`; +1 import and +1 JSX line mounting `<DatasetFolderPickerModal/>` next to `<AddSingleImageModal/>`; the block under "Target Dataset" shows the resolved path + current scope and opens "Browse and scope…"; changing the flat target resets scope to legacy all-content defaults (see PLAN.md's dataset-folder-browser and dataset-folder-scope entries); +1 import `useHelpMode` + `h()` helper and conditional `docKey={h('…')}` on every SimpleJob field that lacks always-on upstream help (Help mode toggle — see PLAN.md) | Re-add the StepSuggestion mount after the `trainingBarClass` grid inside the Training Card; re-add the OptimizerHint mount below the Optimizer select; re-add the DatasetFolderPickerModal mount alongside AddSingleImageModal; re-add the path/scope block directly under the Target Dataset SelectInput, including the atomic dataset-array update and scope reset when the flat target changes; re-add `useHelpMode`/`h()` and the conditional docKeys on fields that previously had no help |
| `ui/src/types.ts` | `DatasetConfig` adds optional `include_loose_files` and `include_subfolders` fields for the fork's per-dataset folder scope | Keep both optional for imported/legacy configs. `undefined` must retain recursive all-content behavior |
| `ui/src/docs.tsx` | +1 import of fork-only `forkDocs`; `getDoc` falls through to `forkDocs` when the upstream registry misses a key | Re-add the import + fallthrough in `getDoc` if upstream rewrites the helper; do not dump fork help copy into the upstream `docs` object |
| `ui/src/components/Modal.tsx` | −1 class: `backdrop-blur-sm` removed from the `fixed inset-0` backdrop (+ a comment block explaining why). A full-viewport backdrop-filter is recomposited every frame while content above it scrolls; measured at ~14fps vs ~59fps at 60Hz on the operator's laptop, with zero main-thread long tasks — see PLAN.md "Fix: modal backdrop blur" (2026-07-28) | Purely a deletion — if upstream restyles the backdrop, just don't reintroduce `backdrop-blur*` on the full-viewport overlay. `bg-opacity-75` is what dims the page and must stay. Scoped blurs on small elements (AddImagesModal, SampleControlImage, etc.) are fine and were left alone |
| `extensions_built_in/captioner/prompts/ideogram4_prompt.py` | The prompt's outer triple-quoted literal is raw (`r"""`) so its documented `\uNNNN` and `\n` examples remain literal. Without this, `\uNNNN` is an invalid Python Unicode escape and the module cannot compile/import | Keep the raw prefix (or escape every backslash example twice). Re-run `testing/test_ideogram4_prompt.py` after upstream prompt rewrites |
| `ui/cron/actions/startJob.ts` | Rewrote `startAndWatchJob` from an async-executor `new Promise` to a plain `async function` with the whole body in one try/catch (`markJobError` helper), and made the fire-and-forget call site (`startJob()`) attach `.catch()`. Fixes a WORKER-process crash: any exception in the unprotected setup code (DB reads, `fs.mkdirSync`/`writeFileSync`) became an unhandled promise rejection that Node treats as fatal, and `concurrently`'s infinite auto-restart turned that into a crash-restart loop that looks like a frozen console — see PLAN.md "Fix: WORKER process crash on job-launch errors (2026-07-17)". **2026-08-01 sync**: upstream independently rewrote the same function to add a Windows subprocess-relay (job launched via a detached `node -e` relay so it survives `taskkill /T`/tree-kills — `WINDOWS_RELAY_SCRIPT`, `readRelayPid`, `isProcessAlive`, `readLogTail`, `watchDetachedJob`, `resolveDetachedPythonPath`). Reconciled by keeping the fork's async/try-catch/`markJobError` wrapper as the outer shape and placing all of upstream's new module-level relay helpers ahead of it, unchanged — they're additive, not conflicting, once the wrapper shape is settled. **Remote execution (2026-08-04)**: +2 imports (`isRemoteGpu`, `startRemoteJob`) and a 4-line early branch at the very top of `startAndWatchJob` — if `gpu_ids` names a machine, hand off and return. Nothing below it changed | If upstream rewrites this function again, re-apply the try/catch restructuring rather than reverting to an async-executor Promise; keep any new upstream helpers as top-level consts above `startAndWatchJob` and let its body flow into the fork's outer try/catch as before. The remote branch must stay the FIRST statement in the function, before any local-path setup (folder creation, log rotation, config write) — those are the peer's job, not this machine's |
| `ui/src/app/settings/page.tsx` | +1 import, +1 JSX line mounting `<PeerSettings/>` immediately after the settings `</form>`, still inside `<MainContent>` | Re-add after the form. It must stay OUTSIDE the `<form>` — it saves itself via `/api/machines` and has nothing to do with the settings POST |
| `ui/src/components/JobOverview.tsx` | +1 import; `gpuIds` memo calls fork-only `parseLocalGpuIndices` instead of `gpu_ids.split(',').map(parseInt)`; +1 `remoteMachine` memo; the "Assigned GPUs" line names the machine for a remote job | Upstream's expression yields `[NaN]` for a `"peer:0"` value, which silently matches no GPU and renders an empty widget. Re-apply the helper swap; the display line is cosmetic and can be dropped if it conflicts |
| `ui/src/components/CaptionMonitor.tsx` | +1 import; same `parseLocalGpuIndices` swap in its `gpuIds` memo | Same reason and same fix as `JobOverview.tsx` |
| `ui/src/components/JobsTable.tsx` | +1 import; +1 early branch in the `jobsDict` memo giving a remote job its own group keyed by the raw `gpu_ids` | Without it, `gpu?.index \|\| '0'` filed every remote job under THIS machine's GPU 0 — reporting the local card busy when it is idle. The group key must remain the raw `gpu_ids` string: the group header looks the queue up with `queues.find(q => q.gpu_ids === gpuKey)` to drive its START/STOP button |
| `ui/cron/worker.ts` | +2 top-level `process.on('unhandledRejection'/'uncaughtException', ...)` handlers that log and keep the process alive, added right after the import | Re-add near the top of the file if upstream restructures it; this is a safety net for the same crash-loop class of bug, not a substitute for fixing the specific cause |
| `ui/src/server/apiCache.ts` | Cache entries carry a `pending` flag; callers share in-flight work past the result TTL, freshness starts when the fetch resolves, failed promises are evicted, and a never-settling fetch becomes replaceable after 30s. Prevents a slow 6s peer probe behind a 5s TTL from duplicating while avoiding a permanently poisoned key | Preserve the separate resolved TTL and pending deadline. A superseded old promise may finish, but identity checks prevent it from replacing the newer entry |
| `ui/src/app/api/gpu/route.ts` | Adds a 10s timeout to the `nvidia-smi -L`/`which` availability subprocess and the full stats query | Keep every external GPU subprocess bounded; this pairs with `apiCache`'s pending deadline so a hung driver command cannot accumulate forever or poison GPU polling |
| `ui/src/app/api/datasets/create/route.tsx` | Validates the requested top-level name and resolves it through fork-only `resolveDatasetPath` before creating a directory | Keep validation before `existsSync`/`mkdirSync`; invalid input returns 400, not a normalized path outside `DATASETS_FOLDER` |
| `ui/src/app/api/datasets/delete/route.tsx` | Resolves the requested name through fork-only `resolveDatasetPath` before recursive deletion | This is a destructive route: never restore a raw `path.join(datasetsRoot, name)`. Invalid input must return 400 before `rmSync` |
| `ui/src/app/api/datasets/upload/route.ts` | Validates the dataset directory and every peer-sanitized filename, then rejects case-insensitive sanitized-name collisions, before creating the directory or writing any file | Keep the entire validation/deduplication pass ahead of `mkdir` so invalid or aliasing later files cannot leave a partial upload or silently overwrite an earlier file |
| `ui/src/app/api/zip/route.ts` | Dataset downloads validate the requested top-level name through fork-only `sanitizeDatasetName`/`resolveDatasetPath`, then confirm the real path remains below `DATASETS_FOLDER` before reading or writing the archive | Upstream's original `path.basename(datasetName)` accepted `..` unchanged and could archive outside the dataset root. Keep invalid input at 400 before I/O and retain the post-`realpath` containment check so a dataset-root symlink cannot escape |
| `ui/package.json` | +1 `test` script: `node --experimental-strip-types --test "tests/*.test.mjs"`. The fork's Node regression tests are written as `.mjs` importing `.ts` directly, which needs the strip-types flag on Node 22; the repo's own `.nvmrc`-less setup means the flag cannot be assumed away | One added line in `scripts`, nothing else. Re-add it if upstream rewrites the script block. Deliberately NOT chained into `build` — a failing fork test must not block an upstream build path. Drop the `--experimental-strip-types` flag once the floor is Node 23+ |
| `.gitignore` | Fork entries appended at the end: `.claude`, `/anima_sample_training`, `/hf-cache`, plus a "Never commit key material" block (`*.key`, `*.pem`, `*.p12`, `*.pfx`, `id_rsa`, `id_ed25519`, added 2026-08-06). Nothing matching those patterns is tracked, so the block is purely preventative | Both sides tend to append to the tail, so this conflicts on most syncs. Always resolve by **keeping both lists** — the fork's entries and upstream's new ones — never by taking one side wholesale |
| `build_and_push_docker` | Docker Hub tags/push target changed from `ostris/aitoolkit` to `socrasteeze/aitoolkit` (both the `:$VERSION` and `:latest` tags, and the final echo). Deliberate per-machine override — see CLAUDE.md's "Local tooling notes" (2026-07-31); was already diverged from upstream before this table tracked it, found and backfilled during the 2026-08-03 sync | Keep the `socrasteeze/aitoolkit` substitution on both `docker tag`/`docker push` lines and the trailing echo; everything else in the script (the `set -euo pipefail`, build args, chmod +x mode) is upstream's and should be taken as-is |
| `toolkit/config_modules.py` | Three independent insertions. (1) `DatasetConfig.__init__` validates/stores `include_loose_files` and `include_subfolders` through fork-only `normalize_included_subfolders`; absent keys preserve upstream recursive behavior. (2) In `TrainConfig.__init__`, +1 commented block after `cache_text_embeddings` adds the fork speed keys (`loss_sync_every` default 1, `ui_db_poll_seconds` default 0.0). (3) The Automagic fused+accumulation guard directly follows the existing accumulation mutual-exclusion `raise` | Re-add the dataset-scope block directly after `dataset_path`; never reinterpret selected names as paths. Preserve the two existing TrainConfig insertions at their documented anchors |
| `toolkit/data_loader.py` | Imports fork-only `list_dataset_media_files` and replaces the inline recursive `os.walk` with that helper, passing the dataset's loose-file/child-folder scope. Default values produce the old recursive list; hidden and `_controls` trees remain excluded | Keep extension selection in this upstream file, then pass the chosen extension list to the helper. Do not flatten selected children into separate dataset configs: per-dataset repeats/weights must apply once to the combined scoped list |
| `extensions_built_in/sd_trainer/SDTrainer.py` | Speed opt, all gated on `train.loss_sync_every > 1` (default 1 = upstream behavior): imports `DeferredLossTracker` + `neutralize_nonfinite_loss`, uses the helper ahead of upstream's synchronous finite check, and defers the final loss `.item()`. Independently removes a dead `if loss.item() > 1e3: pass` in the mean-flow loss path; that branch synchronized CUDA every step and had no effect | Re-apply the two gated insertions (`neutralize_nonfinite_loss(loss)` and lazy `DeferredLossTracker.push()`) if upstream restructures. The helper must explicitly map NaN, +inf and -inf to zero. It is **not** a drop-in for upstream's `elif not torch.isfinite(loss)` branch and the comment must not claim it is: that branch swaps in a detached leaf, this one leaves the graph attached, so a NaN already in the graph can still reach the weights. Keep both paths — the gated one is only for `loss_sync_every > 1` |
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
- `toolkit/fork_speed.py` — speed-optimization helpers (`DeferredLossTracker`: on-device loss accumulation, host sync every N steps; `neutralize_nonfinite_loss`: zero NaN/+inf/-inf without a host sync). Keeps the gated hot-loop insertions in upstream files tiny — see the Speed optimization section below
- `testing/test_fork_speed.py`, `testing/test_ideogram4_prompt.py`, `testing/test_dataset_selection.py` — CPU-only regressions for the fork speed helpers, the Ideogram prompt's literal backslash examples, and dataset loose/child scope
- `toolkit/dataset_selection.py` — validates immediate child-folder names and enumerates the exact trainer media set for legacy all-content, loose-only, selected-child, and nested-root scopes
- `scripts/bench_speed.py` — speed-benchmark harness: runs a config for a fixed step count (sampling disabled, saves out of range), measures end-to-end steps/s from `performance_log_every` timer markers, polls nvidia-smi for peak VRAM, appends a markdown row to `docs/speed_benchmarks.md` (created on first run, also fork-only)
- `docs/anima_a4_parity.md` — A4 gate artifact: matched-run loss-curve/sample comparison vs TrainFlow + Prodigy behavior check (PASS, with documented benign optimizer-construction differences)
- `docs/profiles.md` — performance/background profile explainer + Workstream C gate artifact (measured Anima background-preset VRAM: 30–33% steady, 43% peak of 32GB — PASS)
- `scripts/preflight.py` — B1 dataset pre-flight validator (bare folder or `--config job.yaml`; exit 1 on missing captions/corrupt images/bad paths, warnings for oversized/stray files, `--warn-only` override)
- `scripts/auto_caption.py` — B2 WD14 auto-captioner (wd-eva02-large-tagger-v3 via onnxruntime, HF auto-download, `--general-thresh/--char-thresh/--trigger-word/--overwrite`, multi-threaded, GPU w/ torch-bundled CUDA DLLs)
- `scripts/smart_prep.py` — B3 U2Net subject-aware bucket resize/crop (optional prep tool, non-destructive in→out, `--buckets MINxMAX`, u2net.onnx auto-download to `~/.cache/ai-toolkit/`)
- `scripts/requirements-qol.txt` — extra deps for B2/B3 (`onnxruntime-gpu`); deliberately NOT added to upstream `requirements.txt`
- `ui/src/server/datasetTools.ts` — B5: spawns the QoL CLIs as child processes (uses upstream's `ui/cron/pythonPath.ts` resolver), buffers logs in-memory for polling; deliberately NOT a Prisma job. Finalization is idempotent
- `ui/src/server/toolRunRegistry.ts` — the bookkeeping half of the above, split out so it can be tested without spawning Python or loading Prisma (`datasetTools.ts` reaches both through `cron/paths`). Owns run registration, per-dataset ownership and the one-hour retention timer, which starts only after the child exits so a long tool cannot be evicted mid-run. **A finished run stays discoverable until retention expires** — `getActive` is what backs `GET /api/datasets/tools?datasetName=`, so retiring it at exit made reopening the modal show an empty panel instead of the completed log. Exclusivity does not depend on retiring it: the caller's guard is `status === 'running'`. Retirement is identity-checked on both maps so a stale run's timer cannot evict its replacement
- `ui/src/app/api/datasets/tools/route.ts` — B5: POST starts a preflight/caption/prep run, GET polls by runId or datasetName; source and prep-output paths use the same canonical validator as destructive dataset routes
- `ui/src/components/DatasetTools.tsx` — B5: "Dataset Tools" TopBar button + modal on the dataset page (WD14 tagger options, smart-prep buckets/output, advisory pre-flight, live log). Polling uses the single-flight `usePollLoop`, a 10s Axios timeout, and abort-on-close/run-change, so slow requests cannot overlap and hung/transient requests cannot permanently stop updates. Pre-flight remains advisory only
- `ui/src/hooks/useHelpMode.ts` — session toggle state (`helpModeState`) for revealing extra field-help icons on New Training Job
- `ui/src/components/HelpModeButton.tsx` — TopBar "Help" button; pressed style when help mode is on
- `ui/src/forkDocs.tsx` — fork-only `ConfigDoc` registry for fields without upstream help (plus fixes for dead `assistant_lora_path` / `unconditional_lora_path` docKeys). Merged via `getDoc` in `ui/src/docs.tsx`
- `config/examples/train_lora_anima_2b.yaml`
- `config/examples/train_lora_anima_2b_5090_fast.yaml` — speed-optimized variant (Phase 6): checkpointing off, RAM-served latents, fork speed keys
- `presets/anima_lora_performance.json`, `presets/anima_lora_background.json`
- `presets/anima_lora_5090_fast.json` — the Phase 6 fast profile (see PLAN.md Phase 6 + the Speed optimization section below)
- `presets/*_laptop16gb.json` — the 16 GB laptop tier (2026-07-28): `anima_lora_laptop16gb`, `flux_lora_laptop16gb`, `sdxl_character_lora_laptop16gb`, `illustriousxl_character_lora_laptop16gb`, plus `krea2_lora_laptop16gb` (added 2026-07-29). Memory/IO profiles only — every recipe value is inherited unchanged from the parent preset (see PLAN.md "16 GB laptop tier" and, for the krea2 one, "Krea 2 guidance from a measured 16GB run")
- `ui/src/utils/stepSuggestion.ts` also carries the Anima recipe in `ARCH_RECIPES` (fork file, listed above)
- `start.bat` — double-click launcher for the UI (`start.bat rebuild` after pulling upstream). No longer auto-opens a browser tab on launch (2026-07-20) — `create_shortcut.bat` below is the intended entry point for click-to-open use
- `stop.bat` — killswitch companion to `start.bat`: stops the UI (port 8675) + cron worker even when the launching terminal is gone/frozen, matched by command-line signature so it never touches unrelated node/python. Leaves detached training alone by default; `stop.bat all` also stops a running `run.py` training
- `start-rebuild.bat` — update-and-launch variant of `start.bat` (2026-08-02): fetches and **fast-forwards from `origin` only** on the current branch, then stops any running server (a rebuild against a live server dies with `EPERM` on the locked prisma/sqlite native files), then `npm ci` + `update_db` + `build` + `start`. Refuses to run on a dirty tree and never merges/rebases/forces — upstream merges stay a manual job. Warns (does not act) when the update touched `requirements*.txt`, since it only rebuilds the UI
- `create_shortcut.bat` — one-time setup script that creates a desktop `.lnk` targeting `start.bat`, using the UI's favicon as its icon (instead of a bare `.bat` file on the desktop). Run once; the resulting shortcut is the day-to-day launcher (2026-07-20)
- `presets/` — preset config files (drop-in JSON/YAML). 2026-07-19: seven LDS-ported presets added (zimage char/style/concept, flux2_klein char/style, krea2 concept, sdxl concept) + `flux_lora_24gb.json` v1.1 EMA fidelity fix; provenance table in `presets/README.md`, comparison in `docs/preset_alignment_2026_07.md` (fork-only). 2026-07-21: `flux2_klein_style_lora.json` re-tuned to 64/32 linear + 32/16 conv (a half-scale fold of LDS's researched 128/64/64/32; see the doc's 2026-07-21 update)
- `ui/src/server/presetsPath.ts` — presets-folder resolver + name sanitizer; reuses the shared server Prisma singleton (never construct a second query engine here); also
  `BUILTIN_PRESET_NAMES`/`isBuiltinPreset` (the shipped-preset set the GET route flags so
  the Presets dialog warns before overwriting a provenance-tracked recipe — keep in sync
  with the files that ship in `presets/`)
- `ui/src/server/datasetPath.ts` — pure top-level dataset-name validator + resolved containment check, plus case-insensitive destination-collision detection, shared by read, write and destructive routes
- `ui/src/server/datasetFiles.ts` — dataset scans/subfolder resolution; count/analyze walks delegate scope selection to `datasetScope.ts`; stably re-exports the top-level helpers from `datasetPath.ts` so existing route imports do not churn
- `ui/src/server/datasetScope.ts` — pure loose-file/selected-child traversal and request-scope validator shared by count/analyze routes; each selected immediate child is recursive
- `ui/tests/datasetScope.test.mjs` — Node contract coverage for all-content, loose-only, loose exclusion, selected children, hidden/`_controls` pruning, and unsafe scope payloads
- `ui/src/server/imageSize.ts` — header-only image dimension reader (png/jpg/webp)
- `ui/src/app/api/presets/route.ts` — GET lists presets (each with a `builtIn` flag from
  `isBuiltinPreset`), POST saves/overwrites by name (writeFile — overwrite is the same path)
- `ui/src/app/api/presets/[name]/route.ts`
- `ui/src/app/api/datasets/count/route.ts` — accepts optional `subPath`, `includeLooseFiles`,
  and `includeSubfolders`; path and scope are validated before counting so step estimates
  match the exact trainer selection
- `ui/src/app/api/datasets/analyze/route.ts` — dimension histogram + caption coverage;
  same path and loose/child scoping as `count/route.ts`
- `ui/src/app/api/datasets/browse/route.ts` — non-recursive per-level folder listing +
  breadcrumbs for a dataset (or a subfolder within it), used by the folder-browser modal
  so a job can target a nested folder (e.g. `Dataset/Folder 1/Folder 1a`) instead of only
  a top-level dataset (2026-07-19, see PLAN.md). `datasetName` is validated via
  `sanitizeDatasetName` (datasetFiles.ts) before use, not `path.basename()` alone —
  see the Duplication watch entry below, this matters for `count`/`analyze` too
- `ui/src/components/DatasetFolderPickerModal.tsx` — breadcrumb folder-browser + scope
  modal: choose loose files, all immediate children, or specific immediate children;
  navigating into a child resets to all content within that isolated subtree
- `ui/src/utils/presets.ts`
- `ui/src/utils/stepSuggestion.ts` — step heuristics + exposure gauge + bucket analysis + arch recipes
  (dataset-size-tiered rank/LR/scheduler, Illustrious/Pony detected by checkpoint name since they
  share `arch: "sdxl"` with vanilla SDXL — see the researched-recipe writeup in conversation history
  for source confidence per number; several values are flagged low-confidence/contested in the notes).
  **Every recipe caps effective batch at 2** — see "Effective batch cap" below before raising any
  `batchSetting()` or accumulation rec back to 4
- `ui/src/utils/buckets.ts` — TS port of `toolkit/buckets.py::get_bucket_for_image_size`
- `ui/src/components/OptimizerHint.tsx` — inline guidance under the Optimizer select,
  shown only for the Automagic family: v1/v2 get a "superseded by v3" note + one-click
  switch; v3 explains that LR is a launch point (self-adapting, no scheduler) and offers
  a state-aware "Bound it" button that sets `optimizer_params.min_lr`/`max_lr` (which
  have no UI field anywhere else, like `lr_scheduler`). Guidance sourced from the
  optimizer author's docstrings — see PLAN.md's Automagic v3 research entry. Also
  renders a red warning (above the version-specific content, both branches) when the
  selected optimizer is fused-and-accumulating — the same condition
  `toolkit/config_modules.py`'s guard rejects — with one-click fixes ("Un-fuse it" /
  "Reset accumulation to 1"); see "Automagic + gradient accumulation guard" below
- `ui/src/components/PresetManager.tsx` — Presets dialog: load / save-as-new / delete,
  plus a per-row **Overwrite** button (writes the current form back over a preset; built-ins
  get a stronger confirm, never blocked). Built-in rows show a "built-in" tag from the GET
  route's `builtIn` flag (2026-07-21)
- `ui/src/components/StepSuggestion.tsx` — step suggestion + dataset analyzer panel.
  Derives the dataset name/subPath to query via `deriveDatasetSelection`, which needs
  `DATASETS_FOLDER` (fetched with `useSettings()`) to split `folder_path` correctly for
  nested selections — see the Duplication watch entry on `resolveDatasetSubPath` below
- `ui/cron/gpuIds.ts` + `ui/src/utils/gpuIds.ts` — the `"<peerId>:<localIndex>"` encoding
  for `Job.gpu_ids`. **Two copies on purpose**: the worker build
  (`tsconfig.worker.json`) includes only `cron/**` and cannot import from `src/`. The same
  forced split already exists between `cron/paths.ts` and `src/server/settings.ts`. Keep
  them in step
- `ui/cron/peers.ts` + `ui/src/server/peers.ts` — the peer registry, stored as one JSON row
  in `Settings` under key `PEERS` (fork rule 2: no Prisma schema changes). Same two-copy
  reason as above. The Next-side copy also owns `savePeers`, which preserves a stored token
  when the browser submits the entry without one — the token is never sent to the browser,
  so it cannot be sent back. `caseSensitiveFs` is preserved the same way and for the same
  reason: the peer editor never renders it, so an entry coming back without it means
  "unchanged". Absent = assume a case-insensitive peer, which is the safe reading
- `ui/cron/remoteClient.ts` — HTTP client for a peer: auth header, timeouts, errors that
  name the machine, multipart upload, and a Range-resuming download
- `ui/cron/remoteIntegrity.ts` — testable remote-lifecycle primitives for peer/staging-name
  collision prevention, manifest reconciliation, acknowledged stop retries, and verified
  same-directory checkpoint replacement. Checkpoint temporaries use compact names, retry
  transient Windows sharing failures during cleanup, and surface any files that remain.
  **`temporaryDownloadPath()` must stay a pure function of the destination path** — no PID,
  no UUID, no clock. `remoteClient.ts`'s `peerDownloadFile` resumes from
  `${downloadPath}.part` and stats it on entry, so anything that varies per call silently
  restarts every multi-gigabyte transfer after a worker restart. The matching rule: a
  transfer that broke mid-flight keeps its `.part`; only a completed-but-wrong-size download
  deletes it
- `ui/cron/actions/startRemoteJob.ts` — the remote lifecycle (stage, rewrite, dispatch,
  exact-mirror repair, retry stop until acknowledged, freshly replace checkpoints on rerun,
  fail honestly). See "Remote execution" below
- `ui/src/app/api/machines/route.ts` — GET probes every peer's `/api/gpu` in parallel and
  reports each as online-with-GPUs or offline-with-a-reason; POST saves the registry and
  invalidates the probe cache so its immediate refresh cannot return the old machine list
- `ui/src/hooks/useMachines.ts` — wraps `useGPUInfo` and merges peer GPUs into one option
  list. Reports `isGPUInfoLoaded` for the LOCAL half only, deliberately: callers gate the
  whole job form on it and a switched-off peer takes the full probe timeout to answer
- `ui/src/components/PeerSettings.tsx` — add/remove machines, mounted on the settings page
- `ui/tests/datasetPath.test.mjs`, `ui/tests/apiCache.test.mjs`,
  `ui/tests/remoteIntegrity.test.mjs`, `ui/tests/toolRunRegistry.test.mjs` — CPU-only Node
  regression coverage for containment, upload aliases, bounded in-flight caching, remote
  reset/stop/artifact lifecycle integrity, and tool-run retention. Run them with `npm test`
  in `ui/`. Keep them dependency-free: no Prisma, no network, no child processes — that
  constraint is why `toolRunRegistry.ts` and `remoteIntegrity.ts` exist as separate modules
  at all

## Remote execution: running a job on another machine (2026-08-04)

Pick another machine's GPU in the job form and the job trains there. Design history and
the alternatives considered: PLAN.md.

**The peer runs unmodified.** It is an ordinary install of this fork (or of upstream) with
its own models and its own Hugging Face token. Every call the hub makes is a route the peer
already serves — `/api/settings`, `/api/datasets/upload`, `/api/datasets/listImages`,
`/api/datasets/delete`, `/api/jobs`, `/api/jobs/<id>/{start,stop,log,samples,files}`,
`/api/queue/<gpu>/start`, `/api/files/<path>`. There is no side-channel protocol and nothing
to install. That is the property worth protecting on any future change here.

**Identity rides in `gpu_ids`, which is why nothing else changed.** `Queue.gpu_ids` is
`String @unique` and `processQueue` groups jobs by an exact string match, so `"workshop:0"`
becomes its own queue with its own one-job-at-a-time concurrency **without a single edit to
`processQueue.ts`** and without a schema change. `'mps'` already proved the column carries
non-numeric values.

**What crosses, and what does not:**

| Crosses | Stays put |
|---|---|
| Dataset images + captions (only what changed since last run) | Base model weights — the peer downloads its own |
| The job config, with folders rewritten for the peer | The optimizer state (`optimizer.pt`), too large to be worth it |
| Log bytes, sample images, `.safetensors` — mirrored home | |

**The mirror writes the same `Job` row and the same `{TRAINING_FOLDER}/{job.name}/` folder
a local run would.** That is why no UI code needed changing: the job page, log tail, sample
grid and file list all work against a remote run without knowing it is one. A completed
rerun always downloads each reported checkpoint to a fresh same-directory temporary file,
checks its peer-reported byte count, then atomically replaces the same-name local checkpoint;
an old successful run can no longer masquerade as the new artifact. Stop requests are retried
until the peer acknowledges them instead of being marked sent before a timed-out request.

**Staging is incremental, and the manifest is the marker.** A `.hub_manifest.json` of
`name -> size:mtime` is uploaded into the staged folder *after* the files it describes, so
an interrupted staging leaves the previous, smaller manifest and the next run re-sends the
gap. If the manifest is missing, unreadable, empty or malformed, the folder is untrusted and
is idempotently reset before a full upload. An edited image changes its signature and is
re-sent. `listImages` skips dotfiles, so the manifest never shows up as a dataset image.
Names that become identical under the peer's upload sanitizer (including case-only collisions
for Windows peers) are rejected before any network work. If a trusted manifest entry
disappeared locally, the hub likewise resets only that generated staging dataset and performs
one full re-upload. Its directory includes a stable hash of the real Job id, so different
job names that sanitize alike cannot share or delete one another's inputs.

**Known limits, deliberately not hidden:**

- A dataset with subfolders is refused before anything uploads. The peer's upload route
  writes every file into one directory, so a nested layout would silently collapse into a
  different dataset than the one configured.
- A dataset with a `control_path` is refused for the same reason.
- There is no loop guard: pointing a peer entry at this same instance is not detected.
  Doing so would have the machine queue work to itself under a second name.
- The peer's queue is its own. If someone starts a job on the peer directly, the hub's job
  waits behind it and reports `queued` — which is accurate, but the hub cannot show what it
  is waiting for.

## Speed optimization (Phase 6, 2026-07-19)

Workstream to close the per-step gap with OneTrainer (design history: PLAN.md
Phase 6). The configurable paths are gated and their defaults preserve upstream
training behavior. The one unconditional hot-loop change removes a dead
`if loss.item() > 1e3: pass`; it changes no value or branch outcome, only avoids
forcing the CPU to wait for CUDA in the mean-flow loss path.

Fork config keys (both in `train:`):

| Key | Default (=upstream) | Enabled effect |
|---|---|---|
| `loss_sync_every` | `1` | N > 1: loss syncs device→host every N steps instead of every step (CPU stops waiting on the GPU each step; dataloading/logging overlap compute). Displayed/logged loss updates every N steps; NaN and both infinities are zeroed on-device without the "loss is nan" print |
| `ui_db_poll_seconds` | `0` | > 0: the UI trainer's per-step sqlite work (4 blocking reads + 1 write) runs at most once per interval. UI stop/save-now/sample-now buttons take up to this many seconds to be noticed. CLI runs are unaffected either way |

**2026-08-10 hot-loop audit:** bare `torch.nan_to_num(loss)` was corrected to
explicitly map `nan`, `+inf` and `-inf` to zero; PyTorch otherwise maps infinities
to approximately ±3.4e38, unlike upstream's finite check. The dead mean-flow
`.item()` above was also removed. On the operator's RTX 5090, an isolated 2,000-iteration
CUDA loop measuring that synchronization pattern took 0.0778s with the no-op `.item()`
and 0.0318s without it (2.44x for the microbenchmark; not an end-to-end training claim).

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
5. `fast-profile` — `config/examples/train_lora_anima_2b_5090_fast.yaml` (adds batch 2;
   was batch 4 when this protocol was written — see "Effective batch cap" below)
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

## Automagic + gradient accumulation guard (2026-07-29)

All three Automagic optimizers default to fusing their step into the backward pass via
`register_post_accumulate_grad_hook` (`toolkit/optimizers/automagic{,2,3}.py`; v1/v2
have no unfused mode, v3's `fused` param defaults `True`). Fused + multi-backward
gradient accumulation is a silent wrong-training bug, not a crash: the optimizer steps
once per micro-batch instead of once per accumulation cycle, and the trainer's
post-backward grad clipping / NaN-skip (`extensions_built_in/sd_trainer/SDTrainer.py`,
`hook_train_loop`) never run on the intended cadence. See PLAN.md's 2026-07-29 entry for
the full trace and the preset-audit result (zero shipped presets trip it — check any new
Automagic preset against `toolkit/config_modules.py`'s guard before shipping it).

Three pieces, all fork-only additions to existing fork/upstream files (no new files):
1. **Hard guard** — `toolkit/config_modules.py`'s merge-surface row above.
2. **UI mirror** — `OptimizerHint.tsx`'s fork-only-files entry above.
3. **Docs** — every shipped preset using the batch-1 + accumulation pattern (accumulation was
   4 at the time, lowered to 2 on 2026-07-29 — see "Effective batch cap" below)
   (`anima_lora_background.json`, `anima_lora_laptop16gb.json`,
   `illustriousxl_character_lora_laptop16gb.json`, `sdxl_character_lora_laptop16gb.json`
   — the last three added by the concurrent "16GB laptop preset tier" work, audited
   against this guard the same day) gained one sentence on why swapping the optimizer to
   Automagic needs accumulation reset to 1; `stepSuggestion.ts`'s Krea2 recipe notes (the
   only `ARCH_RECIPES` entry recommending an Automagic optimizer)
   gained the same caveat, since combining that note with the accumulation pattern is
   exactly the config the guard rejects.

## Effective batch cap of 2 (2026-07-29)

**Every arch recipe in `stepSuggestion.ts` and every preset in `presets/` caps
`batch_size × gradient_accumulation` at 2.** Do not raise any of them back to 4 to match a
community guide — the cap is a deliberate operator decision backed by their own runs, and
the reason is structural, not taste:

`suggestSteps()` divides by effective batch and then clamps to the arch's `minSteps` floor.
At effective batch 4 that quotient falls under the floor for any small/medium dataset, the
floor raises it back up, and real per-image exposure (`steps × effectiveBatch ÷ items`)
inflates 2-3x past the arch target — so the advisor recommends a step count its own
`exposureGauge()` would band as fry-risk. Full numbers in PLAN.md's 2026-07-29 entry.

Consequences to preserve on any future edit:
- The Anima recipe/presets deviate from the model author's published effective batch 4.
  This is the one place the fork overrides its highest-confidence source. The deviation is
  flagged in-place (recipe notes + all three Anima preset descriptions) with instructions
  to restore 4 for author-exact reproduction — keep those flags if you touch the text.
- LRs and preset `steps` were deliberately left alone; changing them alongside batch would
  make results unattributable. Don't "finish the job" by scaling them.
- `suggestSteps()`'s explanation string appends a floor-was-hit warning when
  `raw < minSteps`. That is load-bearing for datasets under ~20 images, where the cap alone
  isn't enough — don't drop it when editing the explanation.

## Duplication watch (re-check after each upstream merge)

- **`ui/src/forkDocs.tsx` keys that upstream later adds to `ui/src/docs.tsx` go dead
  silently, and can go WRONG.** `getDoc` checks `docs` first and `forkDocs` only as a
  fallback, so the moment upstream ships its own doc for a key the fork already
  documented, the fork's copy stops rendering — no error, no test, nothing to notice.
  It bit on 2026-08-11: upstream's `ab5fef8` added `datasets.caption_dropout_rate` to
  `docs.tsx`, and the fork's shadowed copy still told users caption dropout "does not
  work with Cache Text Embeddings" — which is precisely the limitation that commit
  removed. The fork's entry was deleted. After every merge, list the overlap and
  delete the fork side of each hit (upstream's is the one users see anyway):

  ```bash
  comm -12 <(grep -oE "^  '[a-z0-9_.]+':" ui/src/forkDocs.tsx | tr -d " ':" | sort -u) \
           <(grep -oE "^  '[a-z0-9_.]+':" ui/src/docs.tsx     | tr -d " ':" | sort -u)
  ```

  The matching `docKey` in `SimpleJob.tsx` moves with it: `h()` gates help for fields
  that **lack always-on upstream help**, so a field upstream has just documented takes
  the bare `docKey="…"` literal rather than the conditional form.
- `ui/src/server/datasetFiles.ts` duplicates the media-extension whitelist from
  `ui/src/app/api/datasets/listImages/route.ts` (route files can't export helpers), while
  `datasetScope.ts` owns hidden/`_controls` pruning. If upstream changes either behavior,
  mirror it in the UI scope walk and in `toolkit/dataset_selection.py`.
- `sanitizeDatasetName` + `resolveDatasetPath` live in `datasetPath.ts` and are re-exported
  by `datasetFiles.ts` to keep existing imports stable. They are required for every route
  that accepts a client-supplied top-level dataset name — `path.basename()` alone does NOT
  stop traversal (`path.basename('..')` returns `'..'` unchanged), and raw `path.join`
  previously exposed both recursive delete and arbitrary upload outside `DATASETS_FOLDER`.
  Current consumers include `count`, `analyze`, `browse`, `tools`, `create`, `delete`,
  `upload`, and dataset downloads in `zip`; any new read/write/destructive route must use
  the shared helper before I/O.
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
- Dataset scope has three synchronized consumers: `toolkit/dataset_selection.py` (actual
  training), `ui/src/server/datasetScope.ts` (count/analyze), and `StepSuggestion.tsx`
  (request payload + cache key). `include_subfolders: null` means every immediate child;
  a list means only those named immediate children, recursively; `[]` means none. Any
  contract change must land in all three or the advisor will measure a different dataset
  than the trainer uses.
- `ui/src/utils/presets.ts` mirrors the "set required fields" logic from the import flow in
  `ui/src/app/jobs/new/page.tsx` (`sqlite_db_path`, `training_folder`, `device`,
  `performance_log_every`). If upstream adds a required field there, add it here too.
- `ui/src/utils/buckets.ts` is a port of `toolkit/buckets.py::get_bucket_for_image_size`
  (divisibility = dataset `bucket_tolerance`, default 64 in `toolkit/config_modules.py`).
  If upstream changes the bucketing math, re-port it or the analyzer's bucket predictions
  drift from what the trainer actually builds.
- `ui/src/server/imageSize.ts` must cover the same image-extension whitelist as
  `datasetFiles.ts` (currently png/jpg/jpeg/webp).
