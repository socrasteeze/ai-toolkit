# HANDOFF

**Updated:** 2026-11-05 · **Branch:** main · **Base:** 4d0a1c43 · **Tree:** clean

## State
Concept Slider control conditioning and the 5090 advisor are implemented and committed.
GPU qualification remains held; the running UI has not been rebuilt or restarted.

## Done this session
- Slider batch expansion and image-conditioned prompts: `9c35646d`, `toolkit/concept_slider.py`.
- 5090 Performance advisor for ordinary Anima/Krea 2 jobs: `c8004941`, `ui/src/utils/performanceAdvisor.ts`.
- CPU validation passed; a separate source export passed the production UI build.
- Delivery cleanup removed personal references and refreshed this handoff.

## Open
1. Build/restart the live UI when requested to display the advisor; do not stop running jobs or services without authorization.
2. GPU tests remain on hold. When authorized, qualify a short Qwen Edit/Edit-Plus Concept Slider run and a plain-image regression run.
3. Benchmark Anima/Krea 2 with Automagic v4 before enabling automated compile, checkpoint or precision/offload choices.
4. Control-aware slider caching remains deferred in `PLAN.md`; resume only on user instruction.

## Decisions
- Keep Automagic v4 preferred and accumulation 1 for the 5090 profile; preserve optimizer parameters and training exposure.
- Cache actions require an explicit Apply and compatible augmentation settings; untested speed settings have no Apply action.
- Image-conditioned slider prompts use each batch's controls and retain the text encoder; text-only models keep their prompt cache.
- Publish only to explicitly named `origin/main`; upstream stays fetch-only and no pull requests are permitted.

## Traps
- No GPU tests were run. CPU checks and the isolated UI build do not establish training speed, peak VRAM or output quality.
- The preflight Torch/Triton pairing falls outside the documented compatibility table; imports passed, compiled execution is unverified.
- The isolated build does not update the live UI. It reported an optional macOS temperature-sensor warning.
- Preserve Ghost privacy rules. Use synthetic fixtures; do not print real dataset names or contents.
- Do not touch legacy slider trainers, `_Archive`, original datasets, or running jobs as incidental cleanup.
- Never link live environments or dependencies into disposable worktrees. Follow the cleanup guard before any managed archive.

## Verify
Passed: 50 focused advisor tests, TypeScript checks, five synthetic slider tests,
the fork runner's 13 non-build checks, and a separate `npm ci` / `npm run build`.
No GPU tests, real training, browser checks or live UI restart ran.

```powershell
$env:CUDA_VISIBLE_DEVICES = '-1'
$env:NO_ALBUMENTATIONS_UPDATE = '1'
.\.venv\Scripts\python.exe -B -m unittest testing.test_concept_slider
.\.venv\Scripts\python.exe -B scripts/verify_fork.py
pwsh -NoProfile -File scripts/run_fork_tests.ps1 -Quick
```

In a separate source export's `ui/`, with independent dependencies:

```powershell
npm ci --no-audit --no-fund
npm run build
```
