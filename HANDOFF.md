# HANDOFF

**Updated:** 2026-11-01 · **Branch:** main · **Base:** 51e298d3 · **Tree:** dirty (this file and `CLAUDE.md`, staged, not committed)

## State
Checkpoint Compare is on `origin/main` at `51e298d3`. Quick checks pass and a smoke render passed, but its Render, Cancel and Promote buttons have no recorded click-through.

## Done this session
- Checkpoint Compare, with the Compare tab and the entry under Generate — `fdfb25be`; design in `PLAN.md`'s 2026-11-01 section
- Render output folder made a setting on the Compare screen, promote destination shown — `51e298d3`
- Checked whether LoRA Royale loads ai-toolkit Anima checkpoints: it does, 280 of 280 modules matched; its repo was not modified

## Open
1. Click Render, Cancel and Promote on a real run in the UI; Promote's copy has only run in the contract test — `ui/src/components/CheckpointCompare.tsx`
2. Decide whether the hardcoded LoRA library root can stay in published code — `ui/src/server/compare.ts:8`
3. Decide whether `/api/compare/img` stays public when `AI_TOOLKIT_AUTH` is set — `ui/src/middleware.ts:7`
4. Render a Krea 2 and a Klein 9B run; neither has been tried

## Decisions
- CLIP ViT-L/14 over ArcFace — `insightface` is not in the venv, and ArcFace needs a model download and no-face handling
- Server-side render loop over a browser-driven one — renders survive switching tabs
- Link to the Generate page to start the engine over duplicating that logic — one code path for engine start
- Folder list over `LoraBrowserModal` for picking runs — promoted folders work too
- Public image route over an authenticated one — `<img>` cannot send the auth header; same as `/api/img`, and still open (Open 3)
- Refuse `_Archive` and IRL paths in code over relying on agent rules — those runs cannot be compared in the UI
- Output folder as a `COMPARE_OUTPUT_FOLDER` Settings row over a hardcoded path — no render path ships in the code

## Traps
- `main` was reset and rewritten on 2026-11-01: `f2b42bab` became `fdfb25be`, and the handoff commits also changed hash. Old hashes in notes are stale
- `ui/.next/BUILD_ID` is newer than `51e298d3`, but no record of that build's result exists here; do not treat it as a passed check
- Likeness scores reward composition and style and center-crop portrait images; use them to rank checkpoints, not to measure face identity
- A prompt containing `--` is parsed as flags, same as on the Generate page
- LoRA Royale reads ai-toolkit filenames in "compared by filename" mode: no epoch labels, and the final file sorts first. Its alpha handling was checked only at rank 32, alpha 32
- Do not restart the UI while `Job.status` shows a running job in `aitk_db.db`. Ghost policy applies here: no real run names, data file names or caption text in this file, commits or docs

## Verify
Passed on `51e298d3`: `verify_fork.py`, `tsc`, the contract test (14 of 14). Not run by this session: `next build`, `npm test`, `run_fork_tests.ps1`.

```powershell
.venv\Scripts\python.exe scripts\verify_fork.py
.venv\Scripts\python.exe -m py_compile scripts\compare_likeness.py
Set-Location ui
npx tsc --noEmit
node --test tests/checkpointCompare.test.mjs
npx next build
npm test
Set-Location ..
.\scripts\run_fork_tests.ps1
```
