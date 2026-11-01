# Handoff: Checkpoint Compare for ai-toolkit (like Fizgig's LoRA Royale)

Repo: D:\ai-toolkit (socrasteeze/ai-toolkit, upstream ostris fetch-only). Work on main, one local commit, do NOT push.
Windows / PowerShell. Venv: D:\ai-toolkit\.venv.

## Hard rules
- No .bak files anywhere. No force-push, no reset --hard; keep existing local commits and unrelated uncommitted work out of the commit.
- Never read/move/copy/write/delete any _Archive folder or any IRL dataset folder.
- No full fork test suite (run_fork_tests.ps1 / next build / npm test). Quick verify only: verify_fork.py, py_compile, tsc --noEmit on touched files.
- No real training runs. Don't restart the UI if a job is running (check Job.status in aitk_db.db).
- Generated images go under the Compare output folder setting, as <output folder>\<run>\ (never D:\Pictures).

## Goal
Pick a training run, render the same prompt + seed with every saved checkpoint, scrub them with a slider, compare each against the real training image, and score likeness so the best checkpoint is obvious. Then promote the winner.

## Inputs
- Runs: under the TRAINING_FOLDER setting (Settings table in aitk_db.db). Checkpoints are <run>_000000NNN.safetensors plus final <run>.safetensors; run config in <run>\.job_config.json (model.arch, model.name_or_path, datasets[0].folder_path, trigger_word, sample settings).
- Also allow pointing at a promoted folder (e.g. D:\anima\lora\trained\<run>\).
- Reference: user picks an image from the run's dataset folder; its sibling .txt caption is the default prompt (editable). Trigger handling must match training: toolkit/prompt_utils.py inject_trigger_into_prompt (plain replace of [trigger]/[name], prepend if missing; no paren escaping).
- Seed fixed (default 42), size = reference image's bucket/aspect at the run's training resolution; steps/CFG default from the run's sample config.
- Optional second "bleed" prompt with no trigger (e.g. "statue, bronze statue, bronze, metal, monochrome").

## Behavior
1. Load the base model once; for each checkpoint (plus optional no-LoRA baseline) swap the LoRA and render. Reuse the fork's existing generate/inference path (ui/src/app/generate/page.tsx, ui/src/app/api/inference/[...path], components/generate/LoraBrowserModal) rather than building a second pipeline.
2. Cache renders by (checkpoint file, mtime, prompt, seed, size, steps, cfg) under <output folder>\<run>\ so reopening doesn't re-render. Show progress and allow cancel.
3. Viewer:
   - Checkpoint slider (step 100 -> final) over the rendered image.
   - Before/after wipe slider: render vs the actual training image.
   - Grid view of all checkpoints as a fallback.
4. Likeness score per checkpoint vs the training image. Prefer a face-identity embedding (insightface/ArcFace) if available in the venv; otherwise DINOv2 or CLIP image similarity. Show which method was used. Highlight the best checkpoint. For the bleed prompt, show similarity too (high = identity bleeding into untriggered prompts).
5. Promote button per checkpoint: same logic as D:\Runs\.scripts\atk\promote.py (dest = realpath(E:\models\loras\<arch folder>) \ trained \ <run> \ <name>.safetensors; anima -> D:\anima\lora, krea/klein/flux/qwen/wan/ltx2 -> F:\Models\loras\<arch>, illustrious -> E:\models\loras\illustrious). Copy only, never move/delete, confirm before overwrite.

## Where in the UI
A "Compare" tab on the job page (ui/src/app/jobs/[jobID]) for runs the UI knows, plus a "Checkpoint Compare" entry under Generate for any run folder.

## Scope / arch
Anima first (base D:\anima\Anima-Base-v1.0-Diffusers). Krea 2 and Klein 9B where the existing generate path supports them; otherwise show a clear "not supported for this arch yet". No FLUX.1 work.

## Verify
- verify_fork.py passes; py_compile on touched .py; tsc --noEmit on touched UI files.
- If no job is running: smoke-render 2 checkpoints of a local run with one of its dataset captions and confirm cached files + scores appear.
- git log -1 --stat shows one local commit on main; nothing pushed.

## Report
Commit hash, what was built and where it lives in the UI, files changed, verification results, likeness method used, gaps/uncertainties, and whether a UI restart is needed.

## Related (separate, read-only)
Check whether Fizgig's LoRA Royale (F:\Fizgig) can load ai-toolkit Anima checkpoints: compare the safetensors key format Royale expects to the keys in a saved Anima checkpoint from a local run (header only). Don't modify Fizgig.