# HANDOFF

**Updated:** 2026-11-08 | **Branch:** main | **Base:** b14dc34c | **Status:** design approved for handoff only; build NOT started

## Goal
Checkpoint Compare (the "LoRA Royal" screen) should read the run's loss log, flag about 3-4
"recommended" checkpoints with plain-language reasons, and let the operator render only a chosen
subset: recommended (default), all, or a hand-picked set. Loss narrows the field; the renders and
CLIP likeness still decide.

## How Compare works today
- UI: `ui/src/components/CheckpointCompare.tsx` (~560 lines). Mounted as the Compare tab in
  `ui/src/app/jobs/[jobID]/page.tsx` and at `/generate/compare` (`ui/src/app/generate/compare/page.tsx`).
- API: `ui/src/app/api/compare/route.ts`
  - GET (no run) -> runs + output folder. GET `?run=` -> run info, `checkpoints[{file,label}]`, references.
    GET `?run=&reference=` -> caption + bucket.
  - POST `action`: `output` | `state` | `render` | `cancel` | `promote`.
  - `ui/src/app/api/compare/img/route.ts` serves renders and reference images.
- Pure helpers: `ui/src/server/compare.ts`
  - `listCheckpoints(folder)`: step from filename only (`_000001200` trainer, `_s1200` promoted); final file -> `step: null`, label "final".
  - `readRunInfo`: reads `.job_config.json`, falling back to `<training root>\<run name>` for promoted folders.
  - `listReferences` / `resolveReference` / `readCaption` / `injectTrigger` / `bucketFor`.
  - `buildPlan(info, req)`: **renders every checkpoint** (+ optional no-LoRA baseline). No subset selection exists.
- Render loop: `ui/src/server/compareRun.ts`. One job at a time against the resident inference engine,
  `lora_mode: 'hook'`, strength 1.0; then `scripts/compare_likeness.py` (CLIP ViT-L/14). Cache:
  `<COMPARE_OUTPUT_FOLDER>\<run>\{baseline|final|s#########}_<sha12>.png` + `scores.json`; cached keys are skipped.
- Note: `selected` in `CheckpointCompare.tsx` is already the slider index. Name new state `chosenFiles`.

## Loss source
- File: `<training root>\<run>\loss_log.db`, written by `toolkit/logging_aitk.py`.
  - `steps(step INTEGER PRIMARY KEY, ...)`
  - `metric_keys(key, first_seen_step, last_seen_step)`
  - `metrics(step, key, value_real, value_text, PRIMARY KEY(step,key))`, index `(key, step)`.
- Resolution: one row per optimizer step per key (reference runs: `loss/loss` + `learning_rate`, steps 1-2999).
- Resume calls `_prune_future_steps`, so the log is one clean series after a resume.
- Existing reader: `ui/src/app/api/jobs/[jobID]/loss/route.ts` (sqlite3, `json_group_array`, gzip).
  `ui/src/components/JobLossGraph.tsx` smooths with a zero-phase (forward+backward, bias-corrected) EMA.
- Checkpoint step truth: every saved `.safetensors` header has `__metadata__.training_info`, e.g.
  `{"step": 3000, "epoch": 18}` (final file included). Use it first; filename regex is the fallback.
- Save interval: `process[0].save.save_every` in the job config; derive from median checkpoint gap if absent.

## Scorer (new `ui/src/server/royalCandidates.ts`, pure TS + read-only sqlite)
Reference implementation: the operator's private prototype scorer (outside the repo, read-only).

1. Loss key: `loss/loss`, else `loss`, else first key containing "loss". Drop null / non-finite values.
2. Checkpoints: step from `training_info.step`, else filename; sort by step. `interval` = median gap.
3. `W = clamp(interval, 100, 500)`. EMA = zero-phase, `alpha = 2 / (W/2 + 1)` (same algorithm as the graph).
4. Per checkpoint, `s = min(step, lastLoggedStep)` (final save lands one step past the last log row).
   Trailing window `(s - W*f, s]`, `f` = level fraction (1.0 single-window mode):
   - `level` = mean raw loss; `noise` = std; `se` = std / sqrt(n)
   - `slopeRel` = linear-fit slope of the EMA over the window * W / level (fraction per save interval); 0 if n <= 10
5. Run constants: `SE` = median se; `noiseMed` = median noise; `best` = min level.
6. Plateau = first checkpoint i with `|slopeRel| < 0.02` AND `level_i - min(level_i..end) < 3*SE`; else last step.
7. Score (higher = better), reasons pushed alongside:
   - `-(level - best)/SE`; if gap < 1.5 -> "loss within noise of the lowest save"
   - bump = `(level - mean(neighbour levels))/SE`; if > 2: `-1.5*(bump-2)`, "loss bump vs neighbours"
   - `slopeRel > 0.02`: `-40*(slopeRel-0.02)`, "loss trending up into this save";
     `slopeRel < -0.04`: `-40*(-slopeRel-0.04)`, "still dropping fast (undertrained?)"; else "flat trailing slope"
   - `noise/noiseMed > 1.15`: `-3*(ratio-1.15)`, "noisier than usual window"
   - before plateau: `-2`, "before plateau"
   - at/after plateau: `-0.6 * (step - plateau)/(lastStep - plateau)` (prefer earlier among near-ties)
8. Ensemble (recommended default): average the score over `f in {0.5, 0.75, 1.0}`. Single-window picks move
   with the window because post-plateau gaps are only 1-2 SE; averaging steadies them. Keep `f=1.0` single
   mode available (option/flag) for the parity check.
9. Picks: top 3 by score with `|step - picked| >= interval`. If no pick is at or before `plateau + interval`,
   add the best such checkpoint with reason "early pick (at plateau onset)". Final save always gets reason
   "final save" and `isFinal: true`, picked or not. Fewer than 4 checkpoints -> all recommended.

Plain words: each checkpoint is scored on how low and steady the loss was just before it saved, with
marks off for a spike, still falling fast, or turning back up; among near-ties the earlier save wins.

## API
New `ui/src/app/api/compare/candidates/route.ts` (beside the compare API so promoted folders work):
`GET /api/compare/candidates?run=<run>` (same `resolveRunFolder` / `assertAllowed` guards). Loss DB is
looked up in the run folder, then `<training root>\<run name>` (same fallback as `readRunInfo`).
```
{ lossAvailable: boolean, lossKey: string|null, interval: number, window: number, plateauStep: number|null,
  sparkline: { steps: number[], values: number[] },   // EMA thinned to ~300 points
  checkpoints: [{ file, step, stepSource: 'metadata'|'filename'|null, score: number|null,
                  reasons: string[], recommended: boolean, isFinal: boolean }] }
```

## Render subset
- POST `state` and `render` accept optional `files: string[]`.
- `buildPlan` filters checkpoints to `files` when present; absent = today's behaviour (all). Baseline toggle unchanged.
- Unknown file names are ignored; an empty filter with no baseline -> error "Pick at least one checkpoint."
- `listCheckpoints` uses the metadata step (keep filename fallback; keep the existing `label` format).

## UI (`CheckpointCompare.tsx`)
- Checkpoint list with checkboxes: green "Recommended" badge (tooltip = reasons), "Final" and "Early" tags, score.
- Buttons: "Select recommended" (default on first load), "Select all", "Clear".
- Mini uPlot sparkline of the EMA: vertical markers at save steps, selected/recommended highlighted, plateau shaded.
- "Render N Missing" counts only `chosenFiles`; send `files` with `state` and `render`.
- Persist `chosenFiles` per run in the existing `checkpointCompare.settings.<run>` localStorage entry.
- No loss log: hide badges/sparkline, note "No loss log, select manually", default to all selected.

## Edge cases
- No `loss_log.db` / no loss key -> `lossAvailable: false`, every `score: null`, all selected.
- < 4 checkpoints -> all recommended.
- Resumed runs: log already pruned. A window with < 10 rows -> `score: null`, reason "no loss rows near this save", not recommended.
- Batch size differences: scores rank within one run only; never compare levels across runs. SE thresholds adapt to batch noise.
- Renamed / promoted files: `training_info.step` first, filename second; neither -> "unknown step", selectable, never recommended.
- Uneven save intervals: `interval` = median gap.
- Final file: `s = lastLoggedStep`.
- Archive / IRL guards (`isForbiddenPath`, `assertAllowed`) on every new path.

## Files to touch
| File | Change | Size |
|---|---|---|
| `ui/src/server/royalCandidates.ts` (new) | scorer, sqlite load, header reader | ~180-220 lines |
| `ui/src/app/api/compare/candidates/route.ts` (new) | GET route | ~50 lines |
| `ui/src/server/compare.ts` | metadata step in `listCheckpoints`; `files` filter in `buildPlan` | ~25 lines |
| `ui/src/app/api/compare/route.ts` | pass `body.files` through | ~10 lines |
| `ui/src/components/CheckpointCompare.tsx` | list, buttons, badges, sparkline, persistence | ~150-200 lines |
| `ui/tests/royalCandidates.test.mjs` (new) + `ui/tests/checkpointCompare.test.mjs` | unit tests | ~120 lines |
| `PLAN.md`, `FORK_NOTES.md` | short sections | ~15 lines each |

## Test plan
Run only the new/related tests (not the full fork suite unless asked):
1. Unit (synthetic fixtures, invented names): a generated `loss_log.db` with a known spike, plateau and final
   save -> spike save not recommended, early pick present, final flagged; < 4 checkpoints -> all; no DB ->
   `lossAvailable:false`; header `training_info` step on a renamed file; `buildPlan` `files` filter + empty-filter error.
2. Parity: run the private prototype scorer with the repo `.venv` Python
   (no args = the two reference runs; its JSON output stays outside the repo). The TS scorer in
   single-window mode (`f=1.0`) must match per-checkpoint `score` within 1e-3 and the same picks. Do not copy
   run names into the repo, tests or commits.
3. Manual: Compare tab -> "Select recommended" -> render; confirm only selected saves render and the cache is reused.

Expected picks (reference runs, save every 300, 3000 steps, batch 2):

| Run | Operator's visual/loss picks | Single window (f=1.0) | Ensemble (0.5/0.75/1.0) |
|---|---|---|---|
| Run A | 2400 / 2100 / 1800 | 1800 / 2100 / 2400, plateau 1800 | 2100 / 1800 / 3000 |
| Run B (avoid 2100) | 2700 / 2400 / 1800 | 2400 / 3000 / 1500 (early), plateau 2400; 2100 scores lowest | 2400 / 1500 / 1800; 2100 still lowest |

The prototype JSON holds the run-name mapping; keep it out of the repo.

## Caveat
After the plateau the checkpoint gaps are only 1-2 standard errors, so exact picks shift with window size.
Stable signals: Run A 1800 and 2100 recommended in every window; Run B 2100 always rejected, 2400 almost always
picked. Loss is for ruling out (undertrained, spikes, rising) and narrowing to 3-4; renders and CLIP decide.

## Constraints
- Work on `main`. No force-push, no `reset --hard`. Commit locally; push only when the operator asks.
- No `.bak` files anywhere.
- Never touch `_Archive` or IRL dataset folders (no read, list, copy, write or delete).
- Ghost policy (`CLAUDE.md`): no real run, dataset or file names in code, tests, docs or commits.
- Don't run the full fork test suite unless asked; run only the new/related tests.
- Don't start, queue or edit training jobs, and don't restart the live UI/engine, without the operator's own go.

## Previous handoff
The 2026-11-05 handoff (`b14dc34c`; concept-slider handoff `0f378ded`) is in git history. The concept slider
Edit/control fix landed in `9c35646d`. Its remaining open items (live UI rebuild, held GPU qualification, Automagic v4
benchmark, deferred control-aware slider caching) are unchanged and still need the operator's go.