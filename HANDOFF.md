# HANDOFF

**Updated:** 2026-09-19 · **Branch:** `main` · **Base:** `f23b514` (delivery tip; this file's commit sits on top) · **Tree:** clean

## State
A recovered, field-proven Krea 2 training template is ported into the fork: three presets, one source-record doc, one diagnostic, advisor notes. Nothing has been run on hardware — every number is inherited from someone else's musubi-tuner runs or from published guidance.

## Done this session
- `presets/krea2_character_lora{,_shift,_laptop16gb}.json` — field recipe (32/16 @ 2e-4), its timestep A/B twin, and the 16 GB laptop profile
- `docs/krea2_field_template_2026_09.md` — source record, dataset-prep method, musubi comparison, port decisions (§1–8)
- `scripts/attn_probe.py` — reports which kernel the dispatcher picks at Krea 2's attention shapes; times the alternatives
- `ui/src/utils/stepSuggestion.ts` — krea2 step corroboration, caption note raised to two-source, timestep contest recorded. No recommended value changed
- `presets/krea2_lora_16gb` v1.3 / `krea2_lora_laptop16gb` v1.2 — name the `layer_offloading` float8 rewrite (closes the 2026-09-16 review's finding 5)
- `docs/profiles.md`, `presets/README.md`, `FORK_NOTES.md`, `PLAN.md` — second exception to the inherit rule, rows, fork-only entries, four addenda

## Open
1. Laptop run — `krea2_character_lora_laptop16gb` has never executed. If VRAM allows, retry at resolution 1024 for the faithful reproduction
2. `python scripts/attn_probe.py --masked`, then again without `--masked`, on the GPU box
3. Timestep A/B — `krea2_character_lora` vs `krea2_character_lora_shift`, same dataset, seed and steps; record the winner in the doc's §7
4. `python testing/test_presets.py` — needs torch, never ran against the three new presets
5. Decide whether the desktop SDXL/Illustrious presets move to effective batch 2 to match the advisor
6. Measure batch 4 for Klein and Krea 2 on the 32 GB desktop, then flip the `DESKTOP32` cells — `ui/src/utils/batchAdvisor.ts`
7. Record which Klein variant OOMs on the 16 GB laptop; `LAPTOP16.flux2_klein` treats 4B and 9B alike until then

## Decisions
- Stay on ai-toolkit over musubi-tuner — its wins (12 GB floor, multi-GPU, exact resume, more attention backends) bind on none of this hardware
- Ship 32/16 @ 2e-4 as a new preset over re-tuning the 32/32 @ 1e-4 ones — `alpha/rank × LR` makes them the same effective 1e-4, so it is a capacity choice, not an LR correction
- Advisor step tiers unchanged despite the template's flat 2200 — it agrees at 70 images and runs 2.3× hot at 30
- Timestep `linear` vs `shift` left unresolved and shipped as an A/B twin — contested, one source each
- No attention backend added — a padding mask disqualifies flash in the dispatcher, and Krea 2 already runs a cuDNN-first SDPA priority list
- Laptop preset at 512 over the parent's 1024 — memory; both are real Krea 2 training resolutions, and the file says which is faithful
- Dataset-prep port (caption surgery, alias triggers, `_facecrop`) scoped in the doc's §6 but NOT built — operator's call
- Fast-forward merge over squash — the commit messages carry the research provenance the docs point at

## Traps
- `train.attention_backend` is a silent no-op for Krea 2 — `set_attention_backend` is not defined on `SingleStreamDiT`
- `layer_offloading: true` rewrites `qtype` qfloat8 → torchao float8 (`toolkit/config_modules.py` ~769), so the preset text and the run disagree
- On 16 GB Windows the failure is shared-memory spill (absurd s/it), not a clean OOM. Keep ~1.5 GB free
- `train.cache_text_embeddings` is mutually exclusive with `diff_output_preservation` — the new presets set the former
- `num_repeats` only duplicates the file list; kohya/musubi repeat advice does not transfer to this step-bounded trainer
- Never push to `upstream` — its push URL stays the literal `DISABLED`, and the remote does not survive a fresh clone. Commit identity is set per clone (`CLAUDE.md`)

## Verify
```powershell
cd ui; npm ci; npx tsc --noEmit; npx tsc -p tsconfig.worker.json --noEmit; npx next build; npm test
pwsh scripts/run_fork_tests.ps1
.\.venv\Scripts\python testing\test_presets.py
.\.venv\Scripts\python scripts\attn_probe.py --masked
```
