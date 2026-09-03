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
pwsh scripts/restore_ui_pkg.ps1        # upstream's package.json/lock + the fork test line
cd ui && npm ci && cd ..               # never `npm install`
python scripts/verify_fork.py          # insertions, touchpoint count, params, doc keys, presets
pwsh scripts/run_fork_tests.ps1        # every gate, reports SKIPs as SKIPs
git push origin main
```

The three scripts replace the checks this procedure used to spell out by hand — the
grep-for-every-insertion pass, the touchpoint recount, the Next 15 `params` sweep, the
`comm -12` doc-key overlap, the built-in preset list, the lockfile verification, and the
Python suites' `PYTHONPATH`. They are described under "Fork-only files" below; the manual
commands are still documented there and in the rows below as the explanation of *what*
each script checks.

> **NEVER open a pull request as part of a sync, and never open one against
> `ostris/ai-toolkit`.** A sync ends at `git push origin main` — that is the whole
> delivery step. This fork's changes are personal (presets, `.bat` launchers, the
> advisor, the QoL scripts) and are never proposed upstream; a previous agent opened
> an upstream PR and put the user's personal config in front of the upstream
> maintainer. The mechanism to watch for: GitHub **defaults a PR's base to the parent
> repo** when a branch is pushed from a fork, so an unqualified "open a PR" targets
> `ostris/ai-toolkit`, not `socrasteeze/ai-toolkit`. `gh` and the API behave the same
> way. Don't create one.

**`ui/package-lock.json` is deliberately kept byte-identical to upstream; `ui/package.json`
differs by exactly the fork's dependency-free `test` script.** The fork adds no npm
dependencies (the QoL Python deps live in `scripts/requirements-qol.txt`). A local
`npm install` can still rewrite the lockfile as a side effect (different npm versions write
different optional-dep metadata, e.g. the `libc` arrays npm 11+ emits and npm 10 does not).
On any merge, take upstream's lockfile, then preserve only the documented test-script line
in the manifest:

```bash
git checkout upstream/main -- ui/package.json ui/package-lock.json
```

Then `npm ci` (not `npm install`) in `ui/` so the lockfile stays untouched.
`scripts/restore_ui_pkg.ps1` does exactly this plus re-applying the one fork line and
verifying the lockfile hash; `-Check` verifies without changing anything.

## Upstream sync log

| Date | Window | Result | Clean-merge catch | Verification |
|---|---|---|---|---|
| 2026-09-03 | 1 commit, `ead3738` — the always-on `/api/monitor` SSE stream is now held once per *browser* instead of once per tab: tabs elect a leader over a `BroadcastChannel`, the leader reads the stream and forwards every event, followers apply the forwarded events and take over on leader silence. Fixes the HTTP/1.1 6-connections-per-host cap that made a 6th tab unable to load anything. 1 file (`ui/src/hooks/useMonitorStream.tsx`), +178/-21 | 1 adopted as-is, 0 adopted with divergence work, 0 rejected | Zero textual conflicts. `useMonitorStream.tsx` is not a fork touchpoint and the merged file is byte-identical to `upstream/main`; the hook's exported surface (`MonitorStreamState`, the default export) is unchanged, so its three consumers (`GPUMonitor.tsx`, `useCPUInfo.tsx`, `useGPUInfo.tsx` — the last one wrapped by the fork's `useMachines`) needed no work. The fork's own monitor divergence is server-side (`ui/src/server/monitor.ts`'s 10s `nvidia-smi` fallback timeout) and does not meet this change. `scripts/verify_fork.py`: insertions, touchpoints, next-params, fork-docs, presets all OK. Fork surface unchanged at **57** modified upstream files; `ui/package-lock.json` byte-identical to upstream, `ui/package.json` still the single fork `test` line | Run in a Linux container, not the operator's Windows box, so `pwsh scripts/run_fork_tests.ps1` was replaced by its gates run by hand and a pre-merge baseline was recorded first for every one of them. Identical before and after the merge: `verify_fork` PASS, `npm test` 62/62 PASS, `tsc --noEmit` PASS (app + worker projects), `next build` PASS, `test_dataset_selection` PASS, `test_ideogram4_prompt` PASS, `test_qol_scripts` PASS, `py_compile` on the fork scripts PASS. Repo-wide grep for conflict markers: none in tracked files. **Not covered:** the three torch-dependent Python suites (`test_fork_speed`, `test_lora_compile_scalars`, `test_presets`) — no torch in this container, and the incoming commit touches no Python; ESLint (the repo configures none — `next lint` only offers to create a config); and the change itself, which is multi-tab browser runtime behaviour no build or unit gate can exercise — the leader election, the takeover on a closed/frozen leader tab, and the `BroadcastChannel`-less fallback path all want a real browser with several tabs open |
| 2026-09-02 | 1 commit, `ecb2bfb` — memory manager: an ignored module's whole subtree is now counted as processed, so no child of a resident module gets a layer manager that would pin its weight back to CPU behind the parent's back. 1 file (`toolkit/memory_management/manager.py`), +7/-1 | 1 adopted as-is, 0 adopted with divergence work, 0 rejected | Zero textual conflicts; the one incoming file is upstream-owned and not a fork touchpoint, so nothing fork-side needed re-verification. `scripts/restore_ui_pkg.ps1 -Check`: test script present, lockfile byte-identical to upstream. `scripts/verify_fork.py`: insertions, touchpoints, next-params, fork-docs, presets all OK. Fork surface unchanged at **57** modified upstream files | `scripts/run_fork_tests.ps1` full run: `verify_fork` PASS, all six fork Python suites PASS (`test_dataset_selection`, `test_fork_speed`, `test_ideogram4_prompt`, `test_lora_compile_scalars`, `test_qol_scripts`, `test_presets`), `py_compile` on fork scripts PASS, `npm test` PASS, `tsc --noEmit` PASS (UI + worker), `next build` PASS. `py_compile` run by hand on `toolkit/memory_management/manager.py`: PASS. Repo-wide grep for conflict markers: none. **Not covered:** the memory-manager change itself is runtime/GPU-bound (only exercised by a real offloaded training run); the cron worker's runtime paths remain untested as always |
| 2026-08-31 | 2 commits, `6940ebf` through `9d6a9a0` — the latent cache now skips (and drops from the dataset) files that fail to load instead of crashing the run, plus a fix to the embedding-offload path so subclass buffers (gemma's `embed_scale`) stay on the CPU and the original `forward` is used rather than a raw `F.embedding`, which had silently dropped the scale for LTX 2.3. 3 files, +39/-11 | 2 adopted as-is, 0 adopted with divergence work, 0 rejected | Zero textual conflicts, and none of the three incoming files (`toolkit/dataloader_mixins.py`, `toolkit/memory_management/manager_modules.py`, `version.py`) is a fork touchpoint, so the merge surface was untouched. The one semantic adjacency worth checking was upstream's new `_remove_file_items()` in `dataloader_mixins.py`, which mutates `self.file_list` after load and remaps `bucket.file_list_idx`: the fork's own file-list work (`toolkit/data_loader.py`'s `list_dataset_media_files` and `toolkit/dataset_selection.py`) runs strictly at list-build time and holds no indices into `file_list`, so there is nothing for the remap to invalidate. Re-verified after the merge anyway: the `list_dataset_media_files` import/call and `config_modules.py`'s `include_loose_files`/`include_subfolders`/`ui_db_poll_seconds`/Automagic-accumulation guard blocks all intact. Fork surface unchanged at **57** modified upstream files | `scripts/run_fork_tests.ps1` full run, all 12 gates PASS: `verify_fork`, the six fork Python suites (`test_dataset_selection`, `test_fork_speed`, `test_ideogram4_prompt`, `test_lora_compile_scalars`, `test_qol_scripts`, `test_presets`), `py_compile` on fork scripts, `npm test` (62 tests), `tsc --noEmit` (UI + worker), `next build`. Pre-merge baseline recorded first and identical. `py_compile` additionally run by hand on the three merged Python files: PASS. **Not covered:** the latent-cache skip path and the embedding-offload fix are both GPU/runtime-bound (they need a real caching run and an LTX 2.3 offloaded train respectively) and no check available here exercises either; the cron worker's runtime paths remain untested as always |
| 2026-08-30 | 4 commits, `2a69c1e` through `e98109f` — Minimax H3 VSA sparse attention, a new `toolkit/dto.py` DTO for latents (carries audio alongside tensors), an LTX caching fix, and a version bump. 22 files, +2318/-249 | 4 adopted as-is, 0 adopted with divergence work, 0 rejected | Two of the twenty-two incoming files were fork-sensitive and both auto-merged clean, re-verified rather than assumed: `extensions_built_in/sd_trainer/SDTrainer.py` (the `toolkit.fork_speed` import, the `loss_sync_every`-gated `neutralize_nonfinite_loss` call, and the deferred `DeferredLossTracker` push all landed intact against upstream's SDTrainer changes) and `toolkit/config_modules.py` (the `include_loose_files`/`include_subfolders`/`normalize_included_subfolders` dataset-scope block and the `ui_db_poll_seconds` speed key both intact). `toolkit/data_loader.py`'s `list_dataset_media_files` import/call, also checked, was untouched by this window. The other twenty files (MiniMax H3's new VSA kernels, the DTO migration touching `toolkit/data_transfer_object/data_loader.py`/`toolkit/dataloader_mixins.py`/`jobs/process/BaseSDTrainProcess.py`, LTX2, memory management, gemma3, mixed precision) are upstream-owned and outside the fork's merge surface. Fork surface unchanged at **57** modified upstream files | `scripts/run_fork_tests.ps1` full run: `verify_fork` PASS, all six fork Python suites PASS (`test_dataset_selection`, `test_fork_speed`, `test_ideogram4_prompt`, `test_lora_compile_scalars`, `test_qol_scripts`, `test_presets`), `py_compile` on fork scripts PASS, `npm test` PASS, `tsc --noEmit` PASS (UI + worker), `next build` PASS. `py_compile` additionally run by hand on all 18 non-fork-script Python files touched by the merge: PASS. Repo-wide grep for conflict markers: none. **Not covered:** the MiniMax H3 VSA sparse-attention kernels and the new latent DTO are GPU/runtime-bound and untested by any check available here; the cron worker's runtime paths remain untested as always |
| 2026-08-29 | 18 commits, `e8d9cf6` through `be99518` — upstream's **Models v2** refactor (phases 0-2 plus `#1025`): model loading rebuilt, offloading and quantization moved onto the base model class, legacy paths kept, a rewritten `toolkit/util/quantize.py`, nvfp4 offload fixes, and two version bumps. 116 upstream files, +5923/-3243 | 18 adopted as-is, 0 adopted with divergence work, 0 rejected | Only **three** files were touched by both sides. `.gitignore` conflicted textually and was resolved as a union: the fork's `/hf-cache` and the key-material block kept, upstream's new `testing/.model_test_outputs` added, the duplicated `.next` collapsed to one entry — neither side's ignores were dropped. `extensions_built_in/sd_trainer/SDTrainer.py` auto-merged clean and was then read, not assumed: upstream's D-OPSD bleed-loss block (`dopsd_normal_target` at the prior-prediction branch, the scaled `bleed_loss` at the loss tail) landed exactly once, and the fork's four insertions — the `toolkit.fork_speed` import, the deleted dead `if loss.item() > 1e3: pass`, the `loss_sync_every`-gated `neutralize_nonfinite_loss`, and the `DeferredLossTracker.push()` loss_dict — all survived in their own regions with no overlap against upstream's hunks. `extensions_built_in/captioner/prompts/ideogram4_prompt.py` is the notable one: **upstream independently shipped the fork's own `r"""` fix**, and went further by dropping the now-redundant `\"` escapes that the raw prefix made literal. Upstream's version is a strict superset of the fork's, so the merge correctly took upstream wholesale and the file is byte-identical to `upstream/main` again. That retires it as a touchpoint — the fork surface drops from **58 to 57** modified upstream files and its row has been removed from the table below. `testing/test_ideogram4_prompt.py` is kept: it now guards upstream's copy of the same invariant, which is exactly when a regression would be easiest to miss. The other 113 incoming files are upstream-owned and outside the fork's merge surface; none of the 55 remaining fork touchpoints were touched by this window, despite its size | Pre-merge baseline recorded first (39 Node / 16 Python, all green) so post-merge results could be compared rather than trusted. Post-merge: `npx tsc --noEmit` **0 errors**, `npx next build` clean (all routes emitted), `npm test` **39 passed / 0 failed**, `py_compile` on both touched Python files PASS, and all four fork Python suites green against the repo `.venv` (`test_dataset_selection` 6, `test_fork_speed` 6, `test_ideogram4_prompt` 1, `test_lora_compile_scalars` 3 — 16 tests, identical to baseline). Repo-wide grep for conflict markers: none. The three JSX mounts and every fork-only module re-verified present by grep, not by assumption. **Not covered:** the entire Models v2 surface is runtime- and GPU-bound — model loading, the new offload path, quantization, and the nvfp4 fix cannot be exercised by any check available here, and the cron worker's runtime paths remain untested as always. A real training run on this box is the first thing that will actually exercise the refactor |
| 2026-08-27 | 3 commits, `8a91256` through `5497a00` (video DOP method fixes, D-OPSD self-reference distillation for MiniMax H3 Ref2VA, and fuller error surfacing on the Qwen Image Omni captioner) | 3 adopted as-is, 0 adopted with divergence work, 0 rejected | Zero textual conflicts. Two of the twelve incoming files were fork-sensitive and both auto-merged correctly: `extensions_built_in/sd_trainer/SDTrainer.py` (upstream added D-OPSD teacher-pass branches around the prior-prediction and audio-target paths; the fork's `loss_sync_every`-gated `neutralize_nonfinite_loss` and deferred `DeferredLossTracker.push()` insertions were re-verified present after the merge, not assumed, and the fork's removal of the dead `if loss.item() > 1e3: pass` in the mean-flow loss path survived — upstream still carries that line, git kept the fork's deletion because the incoming commits did not touch it) and `toolkit/data_loader.py` (upstream added one line; the `list_dataset_media_files` scope helper and the `dataset_batch_size` selection both intact). The other ten files are upstream-owned and outside the fork's merge surface. Fork surface re-derived post-merge: still exactly **58** modified upstream files, unchanged from the prior sync — no new touchpoints, so the file table below needed no edit | `npm ci` (lockfile untouched), `npx tsc --noEmit` **0 errors**, `npx next build` clean, `npm test` **39 passed / 0 failed**, `py_compile` on all 11 touched Python files: PASS. All four fork Python suites run green against the repo `.venv` (`test_dataset_selection` 6, `test_fork_speed` 6, `test_ideogram4_prompt` 1, `test_lora_compile_scalars` 3 — 20 tests, all OK); they need `PYTHONPATH` set to the repo root to import `toolkit`, and the venv has no `pytest`, so they run as direct `unittest` scripts. Not covered by any of this: the cron worker's runtime paths, and the incoming D-OPSD / video-DOP training code itself, which needs a GPU and a real MiniMax H3 run to exercise |
| 2026-08-23 | 1 commit, `8436c40` (delete loss-log rows for a selected range on the job loss graph: new `DELETE` handler on `/api/jobs/[jobID]/loss`, drag-select + delete UI in `JobLossGraph.tsx`, `deleteLossRange` in `useJobLossLog.tsx`) | 1 adopted with divergence work, 0 rejected | Zero textual conflicts. The one fork-sensitive file, `ui/src/app/api/jobs/[jobID]/loss/route.ts`, auto-merged with the fork's `Promise<{ jobID: string }>` `GET` signature intact — but upstream's **new** `DELETE` handler arrived with the stale Next 14 synchronous `params` shape, exactly the recurrence this table's Next 15 param-type row predicts. Re-typed it to `Promise<{ jobID: string }>` (its body already `await`s `params`). `JobLossGraph.tsx` and `useJobLossLog.tsx` are upstream-owned and took the feature as-is. Fork surface re-derived post-merge: still exactly **58** modified upstream files, and the three conflict-prone JSX mounts survived | UI `tsc --noEmit` **0 errors** and `next build` clean (all routes emitted); no Python touched this window, so no `py_compile` pass was needed. Contract suite: **32 Node passed**, identical to the 2026-08-21 baseline. `git rev-list --count HEAD..upstream/main` = 0, no conflict markers, working tree clean apart from the intended route fix |
| 2026-08-21 | 2 commits, `b96476a` through `27a03a9` (per-dataset batch-size overrides and wall-clock/EMA progress-speed reporting) | 1 adopted with divergence work, 1 adopted with divergence checks, 0 rejected | All eight upstream files auto-merged with zero textual conflicts, including four fork-sensitive surfaces. The scope fields/helper, UI DB throttle, deferred-loss path, 10s GPU-probe bounds, remote-peer contract, retired Anima state, and all 58 modified-upstream files survived. Upstream's dataset override made the fork advisor's global-batch assumption stale: added a dependency-free item-weighted harmonic-mean helper for mixed batches and evaluate thin buckets per dataset at its actual batch size; three regression cases pin the math | `npm ci` (lockfile hash unchanged; audit count remained the baseline's 5 high-severity findings), UI and worker `tsc` **0 errors**, `py_compile` on all 5 touched Python files, and `next build` clean apart from the known optional `macos-temperature-sensor` warning: PASS. Contract suites: **32 Node passed** (the baseline 29 plus 3 new mixed-batch cases) and **16 Python passed** (identical to baseline). Isolated production smoke: `/`, `/jobs/new`, and `/api/monitor` all 200. Diff/marker/hygiene scans clean; zero fork/upstream doc-key overlap; `ui/package-lock.json` upstream-identical and the manifest differs only by the documented test script |
| 2026-08-16 | 5 commits, `2cbc2bb` through `42dfe9c` (MiniMax H3 cached-caption trimming, spawn-free backend CPU sampling, combined contrastive-guidance/training-adapter defaults for H3 and Ref2VA, version 0.12.24, and sequential video-frame decoding) | 4 adopted as-is, 1 adopted with divergence checks, 0 rejected | `ui/src/server/monitor.ts` was the only incoming file already modified by the fork. It auto-merged without textual conflict: upstream's new `cpuStats.ts` sampling path landed intact, while the fork's `NVIDIA_SMI_TIMEOUT_MS = 10_000` and bounded one-shot `nvidia-smi` fallback remained present. The 58-file modified-upstream surface, remote-peer contract, retired Anima state, Next 15 catch-all route types, package policy, and fork-doc key separation all remained intact | `npm ci` (lockfile untouched; audit count remained the baseline's 14 high-severity findings), UI and worker `tsc` **0 errors**, `next build` clean apart from the known optional `macos-temperature-sensor` warning, and `py_compile` on all 5 touched Python files: PASS. Contract suites: **29 Node + 16 Python passed**, identical to baseline. Isolated production smoke: `/` and `/api/monitor` both 200 on an explicitly owned port, released after the probe. Diff/marker/hygiene scans clean; `ui/package-lock.json` upstream-identical and the manifest differs only by the documented test script |
| 2026-08-16 | 7 commits, `0f78892` through `97bf49e` (action-bar start animation, an encoded-path/wget-download fix, two MiniMax H3 video-reference reworks with two trailing version bumps) | 6 adopted as-is, 1 adopted with divergence work, 0 rejected | The encoded-path fix (`e6cffbc`) replaced the three catch-all routes' (`audioPath`/`filePath`/`imagePath`) single-string `decodeURIComponent` with a new shared `catchAllToFilePath()` helper (`ui/src/server/catchAllPath.ts`) that assumes Next.js has already decoded each segment — but reverted the params type on all three to the pre-Next-15 synchronous shape upstream still carries there. Kept the fork's `Promise<{ ...: string[] }>` typing per this table's existing note, adopted upstream's `catchAllToFilePath()` call, and dropped the fork's own `decodeURIComponent(...join('/'))` (redundant now, and would double-decode against upstream's new no-decode contract). `extensions_built_in/sd_trainer/SDTrainer.py` auto-merged clean; the `loss_sync_every`-gated `neutralize_nonfinite_loss`/`DeferredLossTracker` insertions were re-verified present after the merge, not assumed | `npm ci` (lockfile untouched, `package.json` differs only by the documented fork test script), `npx tsc --noEmit` **0 errors**, `npx next build` clean, `py_compile` on all 11 touched Python files: PASS. Contract suite: **29 Node passed** (identical to baseline modulo timing/PID noise). The three fork-only Python suites (`test_fork_speed`, `test_ideogram4_prompt`, `test_dataset_selection`) could not run — no `torch`/`huggingface_hub` and no `.venv` in this container, identical gap pre- and post-merge, not merge-caused. Fork surface re-derived after the merge: still exactly **58** modified upstream files, matching the prior sync's count exactly (no new fork-adjacent files this window). The machine-specific absolute path that upstream's `e6cffbc` briefly introduced in a `ui/src/components/SampleImages.tsx` comment had already been replaced with a generic placeholder by sanitization commit `780ba601`; no literal private path remains in the current source or this log |
| 2026-08-14 | 4 commits, `695b0ba` through `4900e5e` (live SSE device monitor + thumbnail-backed viewer controls, then a trailing version bump) | 3 adopted as-is, 1 adopted with divergence work, 0 rejected | The new monitor's one-shot `nvidia-smi` fallback had no timeout; added the fork's mandatory 10s bound. Retained both sides of the `.gitignore` append conflict, preserved dataset-scope types, and updated remote-GPU discovery notes for the new stream. The merge itself was left mid-flight (conflicts resolved and staged, no commit) by an earlier session; this pass concluded it as a proper two-parent merge commit rather than a fresh commit, so ancestry against `upstream/main` stayed intact | `npm ci` (lockfile untouched, `package.json` differs only by the documented fork test script), `npx tsc --noEmit` **0 errors**, `npx next build` clean, `py_compile` on the sole touched Python file (`version.py`), HTTP boot smoke (`/` and the new `/api/monitor` SSE route both 200, worker and UI processes started clean): PASS. Contract suites: **29 Node passed**; **16 Python passed** across all four fork suites (`test_dataset_selection`, `test_fork_speed`, `test_ideogram4_prompt`, `test_lora_compile_scalars`) via the repo `.venv`. Fork surface re-derived after the merge: **58** modified upstream files (`ui/src/server/monitor.ts` is the new addition, documented below), `ui/src/instrumentation.ts`/`ui/src/hooks/useMonitorStream.tsx`/`ui/src/server/monitor.ts`/`ui/src/utils/monitorSample.ts`/`ui/src/app/api/monitor/route.ts` are new fork-adjacent files carried over from upstream's feature |
| 2026-08-14 | 1 commit, `5261d3f` (Add checkpointing to the Wan2.1 encoder) | 1 adopted as-is, 0 adopted with divergence work, 0 rejected | None — the Wan2.1 encoder checkpointing change touched one upstream-owned Python file outside the fork merge surface; all 57 modified upstream surfaces and documented insertion tripwires remained intact | `npm ci`, UI/worker static checks, touched-Python compile/import, production build, HTTP boot smoke, package/docs/divergence/hygiene scans: PASS. Contract suites: 29 Node + 13 Python passed, identical to baseline |
| 2026-08-13 | 2 commits, `6ea2819` through `0e4b6e8` | 1 adopted as-is, 1 adopted with divergence checks, 0 rejected | None — all 26 documented upstream-modified surfaces and fork insertion tripwires remained intact; the MiniMax H3 Ref2Vid changes landed only on upstream-owned diffusion-model and job-option paths | `npm ci`, UI/worker static checks, touched-Python compile, production build, HTTP boot smoke, divergence/hygiene scans: PASS. Contract suites: 29 Node + 13 Python + 10 Python subtests passed, identical to baseline |
| 2026-08-13 | 2 commits, `6b7fb60a` through `ab18528f` (the second window of the day; the clone was shallow on arrival and had to be unshallowed before any merge-base question could be answered) | 2 adopted as-is, 0 rejected | None — the only touched fork file was `toolkit/config_modules.py`, and upstream's one-line `guidance_loss_schedule` default change auto-merged clear of all three fork insertions. Each was re-verified present rather than assumed: the `include_loose_files`/`include_subfolders` scope block in `DatasetConfig`, the `loss_sync_every`/`ui_db_poll_seconds` speed keys in `TrainConfig`, and the Automagic fused+accumulation guard. The other three incoming files (`Qwen3OmniCaptioner.py`, `captionJobConfig.ts`, `captionOptions.ts`) are not fork touchpoints | `npm ci` (lockfile untouched), `npx tsc --noEmit` **0 errors**, `npx next build` clean, `py_compile` on both touched Python files: PASS. Contract suites: **29 Node passed**, **7 Python + 7 subtests passed**. `testing/test_fork_speed.py` could not run — no Torch in this container — so 6 of the usual 13 Python cases are uncovered here; that file is fork-only and untouched by this window. Fork surface re-derived after the merge: still exactly the **26** modified upstream files this table records, `ui/package-lock.json` byte-identical to upstream |
| 2026-08-13 | 3 commits, `a69f3e8` through `4e91fb2` (the local clone initially reported 22 because it had not fetched 19 commits already on `origin/main`) | 3 adopted as-is, 0 rejected | Merged the fork remote's newer dataset-folder-scope feature and absolute remote-operation rules before delivery; no upstream divergence was lost | Worker/static build, touched-Python compile, production build, HTTP boot smoke, divergence/hygiene scans: PASS. Contract suites: 29 Node + 13 Python passed; standalone `tsc --noEmit` retained the baseline's 37 known Next route/page errors with zero new errors |
| 2026-08-12 | 13 commits, `cbf910a` through `742a4c8` | 8 adopted as-is, 5 adopted with divergence work, 0 rejected | New dataset ZIP route used `path.basename()` and accepted `..`; replaced with the shared validator plus a post-`realpath` containment check | UI/worker static checks, touched-Python compile, production build, HTTP boot smoke, divergence/hygiene scans: PASS. Contract suites: 27 Node + 7 Python passed, identical to baseline |

## Upstream files modified (the entire merge surface)

| File | Change | Notes for conflict resolution |
|---|---|---|
| `ui/src/app/jobs/new/page.tsx` | +1 import + JSX mount for `<PresetManager/>`; +1 import + JSX mount for `<HelpModeButton/>` in the TopBar (next to Presets, before Show Advanced); **remote execution (2026-08-04)**: the `useGPUInfo` import/call is replaced by fork-only `useMachines` (which wraps it), the advanced-view GPU `SelectInput`'s inline `gpuList.map(...)` becomes `options={gpuOptions as any}`, and `gpuOptions={gpuOptions}` is passed down to `<SimpleJob/>` | Re-add both mounts in the TopBar button cluster if upstream restructures it — Presets then Help, before Show Advanced / Create Job. For the GPU picker: `useMachines` returns `gpuList` and `isGPUInfoLoaded` with upstream's exact meanings, so a conflict is resolved by keeping upstream's usage and only swapping the hook name back in, plus the `options`/`gpuOptions` lines |
| `ui/src/app/datasets/[datasetName]/page.tsx` | +1 import, +1 JSX line mounting `<DatasetTools/>` in the TopBar after `<AutoCaptionButton/>`. **2026-08-13**: also fixed the page-prop type (see the Next 15 param-type row below) | Re-add next to the Auto Caption button if upstream restructures the TopBar |
| `ui/src/app/jobs/[jobID]/page.tsx` | **2026-08-13**: `params` prop type fixed (see the Next 15 param-type row below) — no other fork changes | None beyond the param-type fix |
| 16 App Router route handlers under `ui/src/app/api/`: `audio/art/[...audioPath]`, `files/[...filePath]`, `img/[...imagePath]`, `jobs/[jobID]/{delete,files,log,loss,mark_stopped,plugin,sample_now,samples,save_now,start,stop}`, `queue/[queueID]/{start,stop}` (plus the fork-only `presets/[name]/route.ts` and the two pages above) | **2026-08-13**: `tsc --noEmit` was silently failing (37 errors, masked by `next.config.ts`'s pre-existing `typescript.ignoreBuildErrors: true`) because these handlers/pages still typed `params` as the old Next 14 synchronous shape (`{ params: { jobID: string } }`) while their bodies already correctly `await params` — a Next 15 requirement upstream itself never finished typing (confirmed present in `upstream/main` too). Re-typed every one to `Promise<{ ... }>`; the three catch-all routes (`audioPath`/`filePath`/`imagePath`) were additionally wrong at the *value* level, not just the type — Next passes catch-all segments as `string[]`, and the old code fed that array straight into `decodeURIComponent()` (only correct by accident for single-segment paths, silently mangling nested-folder paths via an implicit `.toString()` join-by-comma). Fixed by typing them `string[]` and joining with `'/'` before decoding | This is a pre-existing upstream typing gap, not fork-introduced — expect `upstream/main` to carry the same stale sync-param type on any file it touches next in this area. On conflict, keep the `Promise<...>` wrapper (and, for the three catch-all routes, the `string[]` + `.join('/')` handling) and let upstream's functional changes merge in around it; do not revert to the sync shape just because upstream's own incoming diff still has it |
| `ui/src/app/jobs/new/SimpleJob.tsx` | +1 import, +1 JSX line mounting `<StepSuggestion/>` as a full-width sibling AFTER the Training card's column grid (moved out of column 1, 2026-07-19); +1 import, +1 JSX line mounting `<OptimizerHint/>` directly under the Optimizer `SelectInput`; +1 import and +1 JSX line mounting `<DatasetFolderPickerModal/>` next to `<AddSingleImageModal/>`; the block under "Target Dataset" shows the resolved path + current scope and opens "Browse and scope…"; changing the flat target resets scope to legacy all-content defaults (see PLAN.md's dataset-folder-browser and dataset-folder-scope entries); +1 import `useHelpMode` + `h()` helper and conditional `docKey={h('…')}` on every SimpleJob field that lacks always-on upstream help (Help mode toggle — see PLAN.md). Upstream's per-dataset `Batch Size` field (2026-08-21) is adopted intact; the fork advisor reads it from the same dataset config | Re-add the StepSuggestion mount after the `trainingBarClass` grid inside the Training Card; re-add the OptimizerHint mount below the Optimizer select; re-add the DatasetFolderPickerModal mount alongside AddSingleImageModal; re-add the path/scope block directly under the Target Dataset SelectInput, including the atomic dataset-array update and scope reset when the flat target changes; re-add `useHelpMode`/`h()` and the conditional docKeys on fields that previously had no help. Keep upstream's dataset-level batch input and the fork advisor wired to `dataset.batch_size` |
| `ui/src/types.ts` | Upstream owns optional `DatasetConfig.batch_size`; the fork adds optional `include_loose_files` and `include_subfolders` fields for per-dataset folder scope | Keep all three optional for imported/legacy configs. An absent batch uses the train-level batch; absent scope fields retain recursive all-content behavior |
| `ui/src/docs.tsx` | +1 import of fork-only `forkDocs`; `getDoc` falls through to `forkDocs` when the upstream registry misses a key | Re-add the import + fallthrough in `getDoc` if upstream rewrites the helper; do not dump fork help copy into the upstream `docs` object |
| `ui/src/components/Modal.tsx` | −1 class: `backdrop-blur-sm` removed from the `fixed inset-0` backdrop (+ a comment block explaining why). A full-viewport backdrop-filter is recomposited every frame while content above it scrolls; measured at ~14fps vs ~59fps at 60Hz on the operator's laptop, with zero main-thread long tasks — see PLAN.md "Fix: modal backdrop blur" (2026-07-28) | Purely a deletion — if upstream restyles the backdrop, just don't reintroduce `backdrop-blur*` on the full-viewport overlay. `bg-opacity-75` is what dims the page and must stay. Scoped blurs on small elements (AddImagesModal, SampleControlImage, etc.) are fine and were left alone |
| `ui/cron/actions/startJob.ts` | Rewrote `startAndWatchJob` from an async-executor `new Promise` to a plain `async function` with the whole body in one try/catch (`markJobError` helper), and made the fire-and-forget call site (`startJob()`) attach `.catch()`. Fixes a WORKER-process crash: any exception in the unprotected setup code (DB reads, `fs.mkdirSync`/`writeFileSync`) became an unhandled promise rejection that Node treats as fatal, and `concurrently`'s infinite auto-restart turned that into a crash-restart loop that looks like a frozen console — see PLAN.md "Fix: WORKER process crash on job-launch errors (2026-07-17)". **2026-08-01 sync**: upstream independently rewrote the same function to add a Windows subprocess-relay (job launched via a detached `node -e` relay so it survives `taskkill /T`/tree-kills — `WINDOWS_RELAY_SCRIPT`, `readRelayPid`, `isProcessAlive`, `readLogTail`, `watchDetachedJob`, `resolveDetachedPythonPath`). Reconciled by keeping the fork's async/try-catch/`markJobError` wrapper as the outer shape and placing all of upstream's new module-level relay helpers ahead of it, unchanged — they're additive, not conflicting, once the wrapper shape is settled. **Remote execution (2026-08-04)**: +2 imports (`isRemoteGpu`, `startRemoteJob`) and a 4-line early branch at the very top of `startAndWatchJob` — if `gpu_ids` names a machine, hand off and return. Nothing below it changed | If upstream rewrites this function again, re-apply the try/catch restructuring rather than reverting to an async-executor Promise; keep any new upstream helpers as top-level consts above `startAndWatchJob` and let its body flow into the fork's outer try/catch as before. The remote branch must stay the FIRST statement in the function, before any local-path setup (folder creation, log rotation, config write) — those are the peer's job, not this machine's |
| `ui/src/app/settings/page.tsx` | +1 import, +1 JSX line mounting `<PeerSettings/>` immediately after the settings `</form>`, still inside `<MainContent>` | Re-add after the form. It must stay OUTSIDE the `<form>` — it saves itself via `/api/machines` and has nothing to do with the settings POST |
| `ui/src/components/JobOverview.tsx` | +1 import; `gpuIds` memo calls fork-only `parseLocalGpuIndices` instead of `gpu_ids.split(',').map(parseInt)`; +1 `remoteMachine` memo; the "Assigned GPUs" line names the machine for a remote job | Upstream's expression yields `[NaN]` for a `"peer:0"` value, which silently matches no GPU and renders an empty widget. Re-apply the helper swap; the display line is cosmetic and can be dropped if it conflicts |
| `ui/src/components/CaptionMonitor.tsx` | +1 import; same `parseLocalGpuIndices` swap in its `gpuIds` memo | Same reason and same fix as `JobOverview.tsx` |
| `ui/src/components/JobsTable.tsx` | +1 import; +1 early branch in the `jobsDict` memo giving a remote job its own group keyed by the raw `gpu_ids` | Without it, `gpu?.index \|\| '0'` filed every remote job under THIS machine's GPU 0 — reporting the local card busy when it is idle. The group key must remain the raw `gpu_ids` string: the group header looks the queue up with `queues.find(q => q.gpu_ids === gpuKey)` to drive its START/STOP button |
| `ui/cron/worker.ts` | +2 top-level `process.on('unhandledRejection'/'uncaughtException', ...)` handlers that log and keep the process alive, added right after the import; `ensureJournalMode()` (WAL); and (2026-08-29) the queue-scan interval is `queuePollMs` (default 2000, env `AI_TOOLKIT_QUEUE_POLL_MS`) instead of upstream's literal `1000` — at 1 s the scan was 5–9 Prisma round-trips/s against the sqlite file the trainer writes every step | Re-add near the top of the file if upstream restructures it; this is a safety net for the same crash-loop class of bug, not a substitute for fixing the specific cause. Keep `this.interval = queuePollMs` if upstream changes the constructor |
| `ui/src/server/apiCache.ts` | Cache entries carry a `pending` flag; callers share in-flight work past the result TTL, freshness starts when the fetch resolves, failed promises are evicted, and a never-settling fetch becomes replaceable after 30s. Prevents a slow 6s peer probe behind a 5s TTL from duplicating while avoiding a permanently poisoned key | Preserve the separate resolved TTL and pending deadline. A superseded old promise may finish, but identity checks prevent it from replacing the newer entry |
| `ui/src/app/api/gpu/route.ts` | Adds a 10s timeout to the `nvidia-smi -L`/`which` availability subprocess and the full stats query | Keep every external GPU subprocess bounded; this pairs with `apiCache`'s pending deadline so a hung driver command cannot accumulate forever or poison GPU polling |
| `ui/src/server/monitor.ts` | Adds the same 10s timeout to upstream's one-shot `nvidia-smi` fallback for the always-on SSE device monitor | Keep the resident loop's watchdog and the fallback timeout. A driver command that hangs must not hold the monitor tick forever |
| `ui/src/app/api/datasets/create/route.tsx` | Validates the requested top-level name and resolves it through fork-only `resolveDatasetPath` before creating a directory | Keep validation before `existsSync`/`mkdirSync`; invalid input returns 400, not a normalized path outside `DATASETS_FOLDER` |
| `ui/src/app/api/datasets/delete/route.tsx` | Resolves the requested name through fork-only `resolveDatasetPath` before recursive deletion | This is a destructive route: never restore a raw `path.join(datasetsRoot, name)`. Invalid input must return 400 before `rmSync` |
| `ui/src/app/api/datasets/upload/route.ts` | Validates the dataset directory and every peer-sanitized filename, then rejects case-insensitive sanitized-name collisions, before creating the directory or writing any file | Keep the entire validation/deduplication pass ahead of `mkdir` so invalid or aliasing later files cannot leave a partial upload or silently overwrite an earlier file |
| `ui/src/app/api/zip/route.ts` | Dataset downloads validate the requested top-level name through fork-only `sanitizeDatasetName`/`resolveDatasetPath`, then confirm the real path remains below `DATASETS_FOLDER` before reading or writing the archive | Upstream's original `path.basename(datasetName)` accepted `..` unchanged and could archive outside the dataset root. Keep invalid input at 400 before I/O and retain the post-`realpath` containment check so a dataset-root symlink cannot escape |
| `ui/package.json` | +1 `test` script: `node --import ./tests/register.mjs --test "tests/*.test.mjs"`. The fork's Node regression tests are written as `.mjs` importing `.ts` directly; Node strips types natively from 23 on (the box runs 25 — the `--experimental-strip-types` flag was dropped 2026-08-29; re-add it only if the floor ever goes back to Node 22). `--import ./tests/register.mjs` was added 2026-08-24 (fork-only, no npm dependency) so the suites can reach app modules that use Next-style extensionless relative imports — without it only leaf modules with zero relative imports are testable, which is why coverage previously stopped at `advisorBatch.ts` and could not reach `stepSuggestion.ts` | One added line in `scripts`, nothing else. Re-add it if upstream rewrites the script block. Deliberately NOT chained into `build` — a failing fork test must not block an upstream build path. Keep the `--import` hook regardless, it is resolution, not syntax |
| `.gitignore` | Fork entries appended at the end: `.claude`, `.codex` (2026-08-29 — agent scratch; a sync-temp tree under it ended up with ACLs git cannot stat, so every `git status` printed permission warnings), `/anima_sample_training`, `/hf-cache`, plus a "Never commit key material" block (`*.key`, `*.pem`, `*.p12`, `*.pfx`, `id_rsa`, `id_ed25519`, added 2026-08-06). Nothing matching those patterns is tracked, so the block is purely preventative | Both sides tend to append to the tail, so this conflicts on most syncs. Always resolve by **keeping both lists** — the fork's entries and upstream's new ones — never by taking one side wholesale. Since 2026-08-29 `.gitattributes` sets `merge=union` on this file, so git keeps both sides automatically and these conflicts should no longer occur |
| `build_and_push_docker` | Docker Hub tags/push target changed from `ostris/aitoolkit` to `socrasteeze/aitoolkit` (both the `:$VERSION` and `:latest` tags, and the final echo). Deliberate per-machine override — see CLAUDE.md's "Local tooling notes" (2026-07-31); was already diverged from upstream before this table tracked it, found and backfilled during the 2026-08-03 sync | Keep the `socrasteeze/aitoolkit` substitution on both `docker tag`/`docker push` lines and the trailing echo; everything else in the script (the `set -euo pipefail`, build args, chmod +x mode) is upstream's and should be taken as-is |
| `toolkit/config_modules.py` | Three independent fork insertions. (1) `DatasetConfig.__init__` validates/stores `include_loose_files` and `include_subfolders` through fork-only `normalize_included_subfolders`; absent keys preserve upstream recursive behavior. Upstream's optional dataset `batch_size` assignment immediately before `type` is retained. (2) In `TrainConfig.__init__`, +1 commented block after `cache_text_embeddings` adds the fork speed keys (`loss_sync_every` default 1, `ui_db_poll_seconds` default 0.0). (3) The Automagic fused+accumulation guard directly follows the existing accumulation mutual-exclusion `raise` | Keep upstream's `DatasetConfig.batch_size`, then re-add the dataset-scope block directly after `dataset_path`; never reinterpret selected names as paths. Preserve the two existing TrainConfig insertions at their documented anchors |
| `toolkit/data_loader.py` | Imports fork-only `list_dataset_media_files` and replaces the inline recursive `os.walk` with that helper, passing the dataset's loose-file/child-folder scope. Default values produce the old recursive list; hidden and `_controls` trees remain excluded. Upstream selects each bucketed dataset's own `batch_size` when present and otherwise uses the train-level batch | Keep both halves: choose `dataset_batch_size` before constructing `AiToolkitDataset`, then keep extension selection and pass the chosen extension list to the fork scope helper. Do not flatten selected children into separate dataset configs: per-dataset repeats/weights and batch overrides must apply once to the combined scoped list |
| `extensions_built_in/sd_trainer/SDTrainer.py` | Speed opt, all gated on `train.loss_sync_every > 1` (default 1 = upstream behavior): imports `DeferredLossTracker` + `neutralize_nonfinite_loss`, uses the helper ahead of upstream's synchronous finite check, and defers the final loss `.item()`. Independently removes a dead `if loss.item() > 1e3: pass` in the mean-flow loss path; that branch synchronized CUDA every step and had no effect | Re-apply the two gated insertions (`neutralize_nonfinite_loss(loss)` and lazy `DeferredLossTracker.push()`) if upstream restructures. The helper must explicitly map NaN, +inf and -inf to zero. It is **not** a drop-in for upstream's `elif not torch.isfinite(loss)` branch and the comment must not claim it is: that branch swaps in a detached leaf, this one leaves the graph attached, so a NaN already in the graph can still reach the weights. Keep both paths — the gated one is only for `loss_sync_every > 1` |
| `extensions_built_in/sd_trainer/DiffusionTrainer.py` | Speed opt, gated on `train.ui_db_poll_seconds > 0` (default 0 = upstream behavior): one insertion at the top of the `is_ui_trainer` branch of `end_step_hook`, rate-limiting the per-step sqlite work (upstream does 4 blocking SELECTs — stop/return-to-queue/save-now/sample-now, each on a fresh connection — plus the async step write, every step, on the training thread) | Re-apply as an early-`return` time gate (`time.time()` vs `_fork_last_db_poll`, lazy via `getattr`) before `update_step()`/`maybe_stop()`/`maybe_save()`/`maybe_sample()` in `end_step_hook` only — do NOT throttle the other `maybe_stop()` call sites (model load/sample/save), they are rare. UI stop/save/sample buttons take up to `ui_db_poll_seconds` to be noticed when enabled. Legacy `UITrainer.py` (uid `ui_trainer`) deliberately untouched |
(The fork previously also modified `extensions_built_in/diffusion_models/__init__.py`,
`ui/src/app/jobs/new/options.tsx`, and owned `extensions_built_in/diffusion_models/anima/`
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
- `.gitattributes` — one line, `\.gitignore merge=union` (2026-08-29). `.gitignore` conflicted on almost every sync because both sides append to the tail; the documented resolution ("keep both lists, never take one side wholesale") is exactly what git's built-in union driver does, so those conflicts no longer happen. Duplicate ignore lines are harmless; a *removal* from `.gitignore` still needs its own commit, since union merge cannot express a deletion
- `scripts/verify_fork.py` — post-merge tripwire (2026-08-29). Runs the five checks the sync procedure used to do by hand: every documented fork insertion is still present (34 anchors + the Modal backdrop-blur removal, checked with comments stripped so the comment explaining that removal doesn't read as a relapse), the modified-upstream-file count still equals `EXPECTED_TOUCHPOINTS` (skipped, not failed, while the fork is behind upstream — the count is meaningless mid-sync, see CLAUDE.md), every App Router `params` is the Next 15 `Promise<...>` shape, no `forkDocs.tsx` key is shadowed by `docs.tsx`, and `BUILTIN_PRESET_NAMES` equals the files in `presets/`. **Update `EXPECTED_TOUCHPOINTS` and `INSERTIONS` in the same commit as any merge-surface change**, the same way the table above is updated
- `scripts/run_fork_tests.ps1` — one command for the whole validation checklist (2026-08-29): `verify_fork`, the six Python suites (sets `PYTHONPATH` and uses the repo `.venv` — they run as bare `unittest` scripts because the venv has no pytest), `py_compile` on the fork scripts, then `npm test` / `tsc --noEmit` / `tsc -p tsconfig.worker.json` / `next build` in `ui/`. Every gate is optional-by-environment: a missing `.venv`, missing torch or missing `node_modules` is reported as **SKIP with a reason, never as a pass**, and the summary prints what was not covered — so a sync report can state which gates actually ran. `-Quick` skips `next build`
- `scripts/restore_ui_pkg.ps1` — the `ui/package.json` + `package-lock.json` restore dance (2026-08-29): take both from upstream verbatim, re-apply the fork's single `test` script line, verify the lockfile hash is byte-identical to the ref (never `npm install` to "fix" it — that rewrites optional-dep metadata per npm version). `-Check` verifies without changing anything; it stops and asks if upstream ever defines its own `test` script
- `testing/test_presets.py` — preset contract test (2026-08-29): every `presets/*.json` constructs through `TrainConfig`/`DatasetConfig`/`ModelConfig`/`NetworkConfig` (so the Automagic fused+accumulation guard runs on each), effective batch stays ≤ 4, every arch exists in `options.tsx`, and no preset uses weights that are *another* arch's registry default — the last one is the AIO.1 shape (Turbo weights under the base `zimage` arch) and was verified to fail on the reverted preset. Pointing an arch at a non-registry checkpoint stays allowed: that is how the Illustrious/Pony presets work on `sdxl`
- `scripts/qol_common.py` — shared helper for the three QoL CLIs below (2026-08-29): dataset discovery that delegates to `toolkit/dataset_selection.py` (so the scripts see exactly the recursive, dot-folder/`_controls`-pruned file set the trainer trains on — before this they used a flat `iterdir()` and a dataset organised into subfolders made pre-flight fail "no images found" while the tagger/prep tool silently did nothing), `walk_dataset_files` for stray-file reporting, `rel_label` (messages name `sub/x.png`, not just `x.png`), the Windows torch-CUDA-DLL shim that was copy-pasted in two scripts, and `split_buckets_arg`. Puts the repo root on `sys.path` itself, so the scripts run from anywhere
- `testing/test_qol_scripts.py` — CPU-only regressions for the above and the three CLIs' pure/plan functions (nested-dataset discovery, pre-flight report semantics + exit codes, `looks_like_local_path`, caption skip/overwrite selection, smart-prep task planning with subfolder-preserving output and resume)
- `scripts/preflight.py` — B1 dataset pre-flight validator (bare folder or `--config job.yaml`; exit 1 on missing captions/corrupt images/bad paths, warnings for oversized/stray files, `--warn-only` override). Recursive since 2026-08-29 via `qol_common`
- `scripts/auto_caption.py` — B2 WD14 auto-captioner (wd-eva02-large-tagger-v3 via onnxruntime, HF auto-download, `--general-thresh/--char-thresh/--trigger-word/--overwrite`, multi-threaded, GPU w/ torch-bundled CUDA DLLs). Recursive since 2026-08-29; `collect_images()` is the testable selection step
- `scripts/smart_prep.py` — B3 U2Net subject-aware bucket resize/crop (optional prep tool, non-destructive in→out, `--buckets MINxMAX`, u2net.onnx auto-download to `~/.cache/ai-toolkit/`). Recursive since 2026-08-29 and mirrors the source's subfolder layout under `out_dir` (`output_path()`), so a scoped dataset keeps its scope; `plan_tasks()` is the testable planning step
- `scripts/requirements-qol.txt` — extra deps for B2/B3 (`onnxruntime-gpu`); deliberately NOT added to upstream `requirements.txt`
- `ui/src/server/datasetTools.ts` — B5: spawns the QoL CLIs as child processes (uses upstream's `ui/cron/pythonPath.ts` resolver), buffers logs in-memory for polling; deliberately NOT a Prisma job. Finalization is idempotent. 2026-08-29: `cancelToolRun(runId)` kills the child (status becomes `cancelled` when it actually exits), a prep run also locks its output dataset (`locks`), and running children are killed on a clean process exit. **Known limit, documented not fixed:** the registry is process memory — a UI restart forgets finished logs, and a hard `taskkill /F` (what `stop.bat` does) skips the exit hook so a child finishes on its own
- `ui/src/server/toolRunRegistry.ts` — the bookkeeping half of the above, split out so it can be tested without spawning Python or loading Prisma (`datasetTools.ts` reaches both through `cron/paths`). Owns run registration, per-dataset ownership and the one-hour retention timer, which starts only after the child exits so a long tool cannot be evicted mid-run. **A finished run stays discoverable until retention expires** — `getActive` is what backs `GET /api/datasets/tools?datasetName=`, so retiring it at exit made reopening the modal show an empty panel instead of the completed log. Exclusivity does not depend on retiring it: the caller's guard is `status === 'running'`. Retirement is identity-checked on both maps so a stale run's timer cannot evict its replacement
- `ui/src/app/api/datasets/tools/route.ts` — B5: POST starts a preflight/caption/prep run (returns `outputName` for prep), GET polls by runId or datasetName (400 with neither) and takes `?offset=` so it returns only the log appended since (same contract as `api/jobs/[jobID]/log`; the whole ≤200 KB buffer used to ship every second — `datasetTools.ts` keeps a chunked `LogBuffer` and `readLog()` slices it), DELETE `?runId=` cancels; source and prep-output paths use the same canonical validator as destructive dataset routes. 2026-08-29: malformed JSON is a 400 not an unhandled 500; `buckets` is checked for multiples-of-64 / MIN<=MAX here (was an argparse trace in the log pane); an existing prep output folder is a 409 unless `options.resume` is true (a typo naming another dataset used to merge into it silently)
- `ui/src/components/DatasetTools.tsx` — B5: "Dataset Tools" TopBar button + modal on the dataset page (WD14 tagger options, smart-prep buckets/output, advisory pre-flight, live log). Polling uses the single-flight `usePollLoop`, a 10s Axios timeout, and abort-on-close/run-change, so slow requests cannot overlap and hung/transient requests cannot permanently stop updates. Pre-flight remains advisory only
- `ui/src/hooks/useHelpMode.ts` — session toggle state (`helpModeState`) for revealing extra field-help icons on New Training Job
- `ui/src/components/HelpModeButton.tsx` — TopBar "Help" button; pressed style when help mode is on
- `ui/src/forkDocs.tsx` — fork-only `ConfigDoc` registry for fields without upstream help (plus fixes for dead `assistant_lora_path` / `unconditional_lora_path` docKeys). Merged via `getDoc` in `ui/src/docs.tsx`
- `config/examples/train_lora_anima_2b.yaml`
- `config/examples/train_lora_anima_2b_5090_fast.yaml` — speed-optimized variant (Phase 6): checkpointing off, RAM-served latents, fork speed keys
- `presets/anima_lora_performance.json`, `presets/anima_lora_background.json`
- `presets/anima_lora_5090_fast.json` — the Phase 6 fast profile (see PLAN.md Phase 6 + the Speed optimization section below)
- `presets/*_laptop16gb.json` — the 16 GB laptop tier (2026-07-28): `anima_lora_laptop16gb`, `flux_lora_laptop16gb`, `sdxl_character_lora_laptop16gb`, `illustriousxl_character_lora_laptop16gb`, plus `krea2_lora_laptop16gb` (added 2026-07-29). Memory/IO profiles only — every recipe value is inherited unchanged from the parent preset (see PLAN.md "16 GB laptop tier" and, for the krea2 one, "Krea 2 guidance from a measured 16GB run")
- `presets/flux2_klein_9b_character_lora.json`, `presets/flux2_klein_9b_style_lora.json` — the 9B tier (2026-08-24). Identical to the 4B presets except `arch` and `name_or_path`; previously the 9B was only reachable by hand-editing those two fields out of the 4B preset's description text. Just as UNVERIFIED as the 4B pair — no Klein-specific recipe is published
- `presets/*_automagic.json` — automagic3 variants (2026-08-24): `flux2_klein_character_lora_automagic`, `illustriousxl_character_lora_automagic`, `anima_lora_automagic`. Each is its parent preset with `optimizer: automagic3`, `min_lr`/`max_lr` rails (`max_lr` = the parent's own LR, so the controller can only adapt downward — the pattern from `krea2_lora_16gb`), no scheduler, and `gradient_accumulation` pinned to 1 because fused Automagic cannot accumulate. UNVERIFIED per arch: Krea 2 is still the only arch in this fork with a measured automagic3 run
- `ui/src/utils/stepSuggestion.ts` also carries the Anima recipe in `ARCH_RECIPES` (fork file, listed above)
- `start.bat` — double-click launcher for the UI (`start.bat rebuild` after pulling upstream). No longer auto-opens a browser tab on launch (2026-07-20) — `create_shortcut.bat` below is the intended entry point for click-to-open use
- `stop.bat` — killswitch companion to `start.bat`: stops the UI (port 8675) + cron worker even when the launching terminal is gone/frozen, matched by command-line signature so it never touches unrelated node/python. Leaves detached training alone by default; `stop.bat all` also stops a running `run.py` training
- `start-rebuild.bat` — update-and-launch variant of `start.bat` (2026-08-02): fetches and **fast-forwards from `origin` only** on the current branch, then stops any running server (a rebuild against a live server dies with `EPERM` on the locked prisma/sqlite native files), then `npm ci` + `update_db` + `build` + `start`. Refuses to run on a dirty tree and never merges/rebases/forces — upstream merges stay a manual job. Warns (does not act) when the update touched `requirements*.txt`, since it only rebuilds the UI
- `create_shortcut.bat` — one-time setup script that creates a desktop `.lnk` targeting `start.bat`, using the UI's favicon as its icon (instead of a bare `.bat` file on the desktop). Run once; the resulting shortcut is the day-to-day launcher (2026-07-20)
- `presets/` — preset config files (drop-in JSON/YAML). 2026-07-19: seven LDS-ported presets added (zimage char/style/concept, flux2_klein char/style, krea2 concept, sdxl concept) + `flux_lora_24gb.json` v1.1 EMA fidelity fix; provenance table in `presets/README.md`, comparison in `docs/preset_alignment_2026_07.md` (fork-only). 2026-07-21: `flux2_klein_style_lora.json` re-tuned to 64/32 linear + 32/16 conv (a half-scale fold of LDS's researched 128/64/64/32; see the doc's 2026-07-21 update). 2026-08-29: the three `zimage_*` presets (v1.1) moved from `arch: zimage` to `arch: zimage:turbo` + `assistant_lora_path` — v1.0 had paired the Turbo weights with the base arch and no adapter, i.e. trained the distilled model directly (the trainer strips the `:variant`, `toolkit/config_modules.py`)
- `ui/src/server/presetsPath.ts` — presets-folder resolver + name sanitizer; reuses the shared server Prisma singleton (never construct a second query engine here); re-exports
  `BUILTIN_PRESET_NAMES`/`isBuiltinPreset` from:
- `ui/src/server/builtinPresets.ts` — the shipped-preset set (2026-08-29, split out with no imports). `ui/tests/builtinPresets.test.mjs` asserts it equals the files in `presets/`, so adding a preset without listing it fails `npm test` — the list had silently fallen five presets behind. The presets GET route flags built-ins in the dialog; the POST route now refuses to write over ANY existing preset (built-in or not) unless the body carries `overwrite: true`, which only the dialog's confirmed Overwrite button sends (the guard used to be client-only)
- `ui/src/utils/jsonc.ts` — string-aware JSONC comment stripper for the preset read route (2026-08-29). The old regex cut every line at the first `//`, including the one inside an `https://` URL in a description string, on plain `.json` too. `ui/tests/jsonc.test.mjs`
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
- `ui/src/utils/advisorBatch.ts` — dependency-free mixed-dataset batch math. The advisor uses
  the item-weighted harmonic mean (`total items / microbatches per pass`) so global and
  per-dataset batch sizes produce the same exposure/step semantics as the bucketed loader
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
  nested selections. Per-dataset batch overrides feed the mixed-batch step/exposure math,
  and thin-bucket warnings are evaluated per dataset at that dataset's actual batch — see
  the Duplication watch entries below. 2026-08-29: a failed count/analysis is shown with a
  Retry (the panel used to vanish, the same symptom as the 2026-07-19 bug); the count and
  analysis caches expire after 60 s and have a ↻ / Re-analyze control (they used to live for
  the page lifetime, so images added to a dataset were not seen until a reload); video and
  audio archs get a one-line "image models only" note instead of per-image math; recipes
  and step targets reached by family prefix (`flux2` → `flux`, `qwen_image_edit` →
  `qwen_image`, `zimage_l2p` → `zimage`) are labelled inherited/unverified, and archs with
  no data are labelled "generic default" (`stepSuggestion.ts`: `getHeuristicLookup`,
  `ArchRecipe.inheritedFrom`, `StepSuggestionResult.heuristicSource`); a cool gauge reading
  caused only by the arch's `maxSteps` ceiling on a large set says so (`ExposureGauge.ceilingBound`)
  instead of "likely undertrained". A `:variant` arch (`zimage:turbo`, `krea2:turbo`)
  resolves to its base key as an exact match, as the trainer does
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
- `ui/src/app/api/machines/route.ts` — (2026-08-29: probe result cached 30 s, was 5 s; `useMachines` polls no faster than 30 s regardless of the GPU list's cadence — a probe can cost a full 6 s timeout per offline peer, and POST still invalidates) GET probes every peer's `/api/gpu` in parallel and
  reports each as online-with-GPUs or offline-with-a-reason; POST saves the registry and
  invalidates the probe cache so its immediate refresh cannot return the old machine list
- `ui/src/hooks/useMachines.ts` — wraps `useGPUInfo` and merges peer GPUs into one option
  list. Reports `isGPUInfoLoaded` for the LOCAL half only, deliberately: callers gate the
  whole job form on it and a switched-off peer takes the full probe timeout to answer
- `ui/src/components/PeerSettings.tsx` — add/remove machines, mounted on the settings page
- `ui/tests/datasetPath.test.mjs`, `ui/tests/apiCache.test.mjs`,
  `ui/tests/remoteIntegrity.test.mjs`, `ui/tests/toolRunRegistry.test.mjs`,
  `ui/tests/stepSuggestion.test.mjs`, `ui/tests/jsonc.test.mjs`,
  `ui/tests/builtinPresets.test.mjs` — CPU-only Node regression coverage for containment,
  upload aliases, bounded in-flight caching, remote reset/stop/artifact lifecycle integrity,
  tool-run retention + output-folder locks, mixed per-dataset batch math, (2026-08-24) the
  effective-batch ceiling sweep, (2026-08-29) recipe/target provenance flags, the
  ceiling-bound gauge, the README threshold table, JSONC stripping and the built-in preset
  set. Run them with `npm test`
  in `ui/`. Keep them dependency-free: no Prisma, no network, no child processes — that
  constraint is why `toolRunRegistry.ts` and `remoteIntegrity.ts` exist as separate modules
  at all
- `ui/tests/register.mjs` + `ui/tests/tsResolve.mjs` — fork-only ESM resolve hook wired into
  the `test` script (2026-08-24). Lets the dependency-free suites follow Next-style
  extensionless relative imports, which is what made `stepSuggestion.ts` testable at all.
  Bare Node only — no npm dependency, and it affects nothing outside `npm test`

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

**Audited and deliberately NOT changed:** `pin_memory` (no-op with the custom DTO
collate); EMA (already off by default); attention (already SDPA for Anima); the extra
per-step sync in `get_avg_learning_rate()` (automagic-family only — not in the
Anima recipe, but it IS in the four `*_automagic` / `krea2_lora_16gb` presets); legacy
`UITrainer.py`. **Corrected 2026-08-29 (two earlier claims here were stale):**
(a) `num_workers` is no longer hardcoded to 0 on Windows — upstream reads
`dataset.num_workers` (default 2) / `prefetch_factor` and sets `persistent_workers`
(`toolkit/data_loader.py` ~730-738), so a per-preset value is a config-only lever;
(b) `torch.compile` is upstream-native (`ModelConfig.compile`, `block_compile`,
`compile_mode`, `compile_fullgraph`, `compile_dynamic` in `toolkit/config_modules.py`;
implementation with per-block compile and rollback-on-failure in
`jobs/process/BaseSDTrainProcess.py`) and `triton_windows` is installed in the repo
`.venv` on torch 2.9.1+cu128, so the "Windows/Triton viability" question is answered —
no fork code is needed, only a preset and a measured run (see PLAN.md 2026-08-29
performance pass). **Still deferred (needs a measured run):** fused AdamW
(`optimizer_params: {fused: true}` already passes through `toolkit/optimizer.py` for the
non-quantized, non-offloaded anima presets), `gradient_checkpointing: false` on
`anima_lora_performance`, `layer_offloading_transformer_percent` < 1 on the krea2
offload presets, `cache_text_embeddings` on the non-anima presets.

**Preset levers (2026-08-29):** every shipped preset now carries `cache_latents: true`
alongside `cache_latents_to_disk: true` (disk-only caching re-read + deep-copied every
latent from disk every step — `toolkit/dataloader_mixins.py` `cleanup_latent`/`get_latent`;
only the fast and laptop profiles had both before), `loss_sync_every: 4` and
`ui_db_poll_seconds: 2`. All three are config-only, cost no VRAM, and leave the training
math unchanged. The config defaults stay at upstream's (`loss_sync_every` 1,
`ui_db_poll_seconds` 0) so hand-written configs behave exactly as upstream.

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

## Exposure target scales with dataset size (2026-08-29)

`stepSuggestion.ts`'s per-arch `stepsPerItem` is damped on large datasets by
`sizeTargetScale(n) = min(1, (65/n)^(1/3))`, so a big set is no longer graded against a
target sourced for a small one. The exponent comes from krea2's measured+published triple
(45/32/20 at ~20/~60/~250 images) and is validated by a test: applied to krea2's measured
anchor it predicts 20.4 steps/item at 250 images vs its published 20. **It only ever damps**
— at or below 65 images the scale is exactly 1, so no small/medium advice moved and the
batch-4 thresholds (29/32/40/45 files) cannot drift — and **krea2 is exempt**, because its
own tier function already expresses the size effect and compounding would double-count it.
Changing the anchor or exponent must keep the krea2 corroboration test green. The remaining
large-set distortion is the `maxSteps` ceiling, not the target; raising it needs its own
evidence and is deliberately still unguessed (`ExposureGauge.ceilingBound` labels it).

## Effective batch: size-gated ceiling of 4 (2026-08-24, supersedes the flat cap of 2)

**Effective batch (`batch_size × gradient_accumulation`) may go up to 4, but only where the
dataset is large enough that the `minSteps` floor doesn't bind.** From 2026-07-29 to
2026-08-24 this was a flat cap of 2. The flat cap was a workaround; the underlying bug is
what must stay fixed, and it is now fixed directly:

`suggestSteps()` divides by effective batch and then clamps to the arch's `minSteps` floor.
On a small dataset that quotient falls under the floor, the floor raises it back up, and real
per-image exposure (`steps × effectiveBatch ÷ items`) inflates 2-3x past the arch target — so
the advisor recommends a step count its own `exposureGauge()` would band as fry-risk. Full
numbers in PLAN.md's 2026-07-29 entry; the fix in its 2026-08-24 entry.

**The mechanism that replaced the cap** (`ui/src/utils/stepSuggestion.ts`):
- `bandForRatio()` is now the single source of truth for the band thresholds. `exposureGauge()`
  and the new ceiling logic both read it, so they cannot drift apart — that drift *was* the bug.
- `maxHealthyBatch(itemCount, arch)` returns the largest effective batch on
  `EFFECTIVE_BATCH_LADDER` (1/2/4) whose floor-clamped suggestion stays out of the fry band.
  Exposure is non-decreasing in effective batch, so the first fry result ends the search.
- `minItemsForBatch(effectiveBatch, arch)` answers "how many files before batch 4 is safe":
  SDXL/Illustrious 29, Anima 32, Klein 4B/9B 40, Krea2 45.
- `suggestSteps()` returns `batchCeiling` and `overBatched`, and names both the ceiling and the
  required file count in the explanation string.

Consequences to preserve on any future edit:
- **The contract sweep in `ui/tests/stepSuggestion.test.mjs` is the regression guard.** It
  walks 10,800 arch × itemCount × batch combinations asserting `overBatched` is true for every
  fry-band result, except the irreducible case (≤9 files, ceiling already 1, no batch left to
  lower). If you touch the bands, the floors, `roundTo50`, or the ladder, that test tells you
  whether you reintroduced the 2026-07-29 bug. Don't weaken it to make an edit pass.
- Anima's recipe matches the model author's published effective batch 4 on the `large` tier
  only; below it the fork still suggests 2 and flags the deviation in-place. Keep both halves
  of that note — the provenance is the point.
- LRs and preset `steps` are still deliberately untouched; changing them alongside batch would
  make results unattributable. Don't "finish the job" by scaling them.
- `suggestSteps()`'s floor-was-hit warning still fires independently of `overBatched` and is
  still load-bearing under ~20 images, where no batch choice rescues the exposure — don't drop
  it when editing the explanation.
- Automagic-family optimizers cannot reach effective batch >1 via `gradient_accumulation` while
  fused (see the guard below) — raise `batch_size` instead. The three `*_automagic*` presets
  pin `gradient_accumulation: 1` for this reason.

## Duplication watch (re-check after each upstream merge)

Every item in this section is now also checked mechanically by `scripts/verify_fork.py`
(insertions, touchpoint count, Next 15 `params`, doc-key overlap, preset list) or by a
test (`testing/test_presets.py`, `ui/tests/builtinPresets.test.mjs`,
`ui/tests/stepSuggestion.test.mjs`'s README-threshold case). The prose stays because it
explains *why* each invariant exists — the scripts only tell you that one broke.

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
  than the trainer uses. The QoL CLIs (`scripts/qol_common.py`, 2026-08-29) are NOT a
  fourth copy — they import `list_dataset_media_files` from the Python side directly, so
  they follow it automatically; only `walk_dataset_files` (stray-file scan) mirrors its
  dot-folder/`_controls` pruning by hand.
- `StepSuggestion.tsx` reads `modelArchs` from upstream's `ui/src/app/jobs/new/options.tsx`
  for the arch `group` (`image`/`video`/`audio`) to suppress per-image math on video and
  audio models. If upstream renames the field or the group values, the advisor will simply
  render for everything again (no crash) — re-check after a merge that touches `options.tsx`.
- Dataset batch has three synchronized consumers: upstream `toolkit/data_loader.py` (the
  actual pre-batched dataset), upstream `SimpleJob.tsx`/`ui/src/types.ts` (configuration),
  and fork `StepSuggestion.tsx` + `advisorBatch.ts` (advice). Mixed batches combine as
  `total selected items / total microbatches per pass`, not an arithmetic mean; bucket
  warnings stay per dataset because `AiToolkitDataset` batches before concatenation.
- `ui/src/utils/presets.ts` mirrors the "set required fields" logic from the import flow in
  `ui/src/app/jobs/new/page.tsx` (`sqlite_db_path`, `training_folder`, `device`,
  `performance_log_every`). If upstream adds a required field there, add it here too.
- `ui/src/utils/buckets.ts` is a port of `toolkit/buckets.py::get_bucket_for_image_size`
  (divisibility = dataset `bucket_tolerance`, default 64 in `toolkit/config_modules.py`).
  If upstream changes the bucketing math, re-port it or the analyzer's bucket predictions
  drift from what the trainer actually builds.
- `ui/src/server/imageSize.ts` must cover the same image-extension whitelist as
  `datasetFiles.ts` (currently png/jpg/jpeg/webp).
