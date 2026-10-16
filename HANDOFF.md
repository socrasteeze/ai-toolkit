# HANDOFF

**Updated:** 2026-10-15 · **Branch:** `main` · **Base:** `89db2ee` (this delivery sits on top) · **Tree:** dirty — `presets/anima_automagic_gen_lora.json` deliberately left uncommitted

## State
Upstream is synced through `12395a1` (FLUX.3 Image, band loss), validated 13/13, pushed. The only thing not pushed is one preset that a job-form Overwrite rewrote. It holds personal fields and the operator still has to make a recipe decision on it.

## Done this session
- Upstream sync (13 commits, clean merge, fork surface 60) + the unlogged 2026-10-14 window — `FORK_NOTES.md` sync log
- Stale merged `noble/*` branches deleted on origin (4 total); origin now has only `main`
- Anima job failure diagnosed: upstream's loader needs a Diffusers folder or repo, not a single `.safetensors` — no code change; a local Diffusers copy was made outside the repo
- Shipped the other session's finished work: PresetManager modal wrapping/feedback (`ui/src/components/PresetManager.tsx`), advisor fractional-exposure fix (`6e8d6aa`)

## Open
1. Decide `presets/anima_automagic_gen_lora.json`: restore to HEAD (`git restore`) or keep its new recipe (batch 2, 1000 steps, low_vram off) with trigger word, default caption, sample prompts and `name_or_path` reset first. The repo is PUBLIC
2. Rebuild + restart the production UI to pick up the PresetManager and advisor fixes — `start-rebuild.bat`
3. First Anima run with `name_or_path` pointed at the local Diffusers folder — confirm it trains offline
4. Krea 2 on hardware: `krea2_laptop_adamw_char_lora` laptop run (retry at 1024 if VRAM allows), then `scripts/attn_probe.py` with and without `--masked`
5. Two A/Bs vs `krea2_char_lora` (same dataset/seed/steps): `_shift` (record in the doc's §7) and `_automagic` (record where LR settled)
6. `batchAdvisor.ts` unmeasured cells: batch 4 Klein/Krea 2 on `DESKTOP32`; Klein 4B vs 9B on `LAPTOP16` — measure `k9b_laptop_char_lora`/`_lokr` s/it + VRAM
7. Decide whether the desktop SDXL/Illustrious presets move to effective batch 2 to match the advisor

## Decisions
- Local Diffusers folder over patching upstream `anima/anima.py` for single-file loads — keeps the fork surface at 60
- Personal-field preset held out of the push instead of auto-stripped — the overwrite also changed the recipe, which is the operator's call
- No `flux3` advisor recipe — no research basis yet; do not add a guessed one
- Upstream's 13 commits keep their original authorship — rewriting them breaks ancestry against `upstream/main`
- Timestep `linear` vs `shift`, adamw8bit vs automagic3 left unresolved, shipped as one-variable A/B twins
- Dataset-prep port (alias triggers, `_facecrop`) scoped in the Krea 2 doc's §6 but NOT built — operator's call

## Traps
- The preset **Overwrite** button writes the whole job form (trigger word, captions, sample prompts, local paths) into a TRACKED preset on a PUBLIC repo — scan `presets/` before every commit
- Anima `name_or_path` as a single `.safetensors` fails with "Could not find or load 'modular_model_index.json'" — use the Diffusers repo id or a local Diffusers folder
- `train.attention_backend` is a silent no-op for Krea 2 (`SingleStreamDiT` has no `set_attention_backend`)
- `layer_offloading: true` rewrites `qtype` qfloat8 → torchao float8 (`toolkit/config_modules.py`), so preset text and run disagree
- 16 GB Windows fails as shared-memory spill (absurd s/it), not a clean OOM — keep ~1.5 GB free; `cache_text_embeddings` excludes `diff_output_preservation`
- Advisor LR chip is withdrawn under `automagic*` (re-adding it clobbers launch LR); `krea2_automagic_char_lora`'s `max_lr` ≠ launch LR is deliberate — do not "fix" it
- `num_repeats` only duplicates the file list; kohya/musubi repeat advice does not transfer
- Never push to `upstream` (push URL stays the literal `DISABLED`; remote does not survive a fresh clone); never open a PR; identity is set per clone (`CLAUDE.md`)

## Verify
```powershell
cd ui; npm ci; npx tsc --noEmit; npx tsc -p tsconfig.worker.json --noEmit; npx next build; npm test
pwsh scripts/run_fork_tests.ps1
.\.venv\Scripts\python testing\test_presets.py
git diff "$(git merge-base HEAD upstream/main)..HEAD" --name-status | Select-String -NotMatch '^A'
```
