# HANDOFF

**Updated:** 2026-11-08 · **Branch:** main · **Base:** ae650196 · **Tree:** clean except untracked `output_atk/`

## State
Compare's loss-based candidate picker is on `main` and live on the 8675 UI.
Only the checks that need a real render remain, blocked while training holds the GPU.

## Done this session
- Candidate picker: scorer, API, render subset, UI — `ui/src/server/royalCandidates.ts`, `ui/src/app/api/compare/candidates/route.ts`, `ui/src/components/CheckpointCompare.tsx`
- Independent plan and code review approved the final tree (three plan rounds, three code inspections)
- Parity on both private reference runs: single-window scores match the prototype, ensemble picks as expected
- Browser checks on the rebuilt UI passed: default recommended, Select All, Clear, reload restoring empty, baseline-only and hand-picked sets, server `files` filter, no-loss display (forced by failing the candidates request; all 69 real runs have a log)
- `start-rebuild.bat` restored, no longer blocked by untracked files, proven by a real desktop-shortcut run with training alive

## Open
1. When the GPU is free, start the engine on Generate, then Compare, Select Recommended, render: only chosen saves render and a second click reuses the cache. Not run: training held the GPU at 100%.
2. During that render press Clear: progress and Cancel stay. Not run, same reason.
3. With a run still training, confirm a new save appears unchecked without a reload. Not run.
4. Carried, each needs the operator's go: held GPU qualification, Automagic v4 benchmark, deferred control-aware slider caching.

## Decisions
- `listCheckpoints` keeps filename steps over header steps — header steps would rename the final file's cache key and promoted name
- `state` poll sends no `files`, client filters rows, over a filtered poll — selection cannot race a poll or hide Cancel
- Score is the mean over 50/75/100% windows, plateau and reasons from 100% — single-window picks move with window size
- Log-tail tolerance is max(5, median row gap) over a fixed 5 — logs written every N steps end up to N before the final save
- Candidates refresh on save-list change only, over polling — reviewer objected (medium); it is an advisory filter and a reload refreshes it
- Inline SVG sparkline over uPlot — about 300 static points need no chart lifecycle

## Traps
- `for /f` turns an unescaped `=` into a space: `--untracked-files=no` silently disabled the dirty check, so `start-rebuild.bat` uses `-uno`
- Agent shells set `NoDefaultCurrentDirectoryInExePath=1`, so `cmd /c start-rebuild.bat` fails; launch the desktop shortcut or use an absolute path
- Runs trained from YAML default to `log_every` 100: too few rows per window, so nothing is recommended and all saves are selected. UI jobs log every step
- `next build` or a dev preview disturbs the live UI; rebuild only through `start-rebuild.bat`, which leaves training running
- `start-rebuild.bat` vanished from the working tree once on 2026-11-08, cause unknown; the desktop shortcut depends on it
- Ghost policy: real run, dataset and file names stay out of code, docs and output; `output_atk/` is never committed

## Verify
```powershell
cd ui
node --import ./tests/register.mjs --test tests/royalCandidates.test.mjs tests/checkpointCompare.test.mjs
npx tsc --noEmit
```
