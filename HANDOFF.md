# HANDOFF

**Updated:** 2026-09-19 (2nd) · **Branch:** `claude/krea2-training-template-vsqaxn` · **Base:** `main` · **Tree:** clean

## State
A field-proven Krea 2 training template (recovered by the operator from their own musubi-tuner
runs) is ported into the fork: one new preset, one source-record doc, advisor notes updated. No
recommended advisor VALUE changed — the template corroborates the existing LR and the medium-tier
step target rather than replacing them. Nothing reproduced on this trainer; the source runs were
musubi-tuner (`krea2_train_network.py`) on RunPod 4090/H100.

## Done this session
- `presets/krea2_character_lora.json` (new) — rank 32 / alpha 16 @ LR 2e-4, adamw8bit, bf16 + qfloat8 base, gradient checkpointing, `buckets: true` at 1024, latents + text embeds cached, 2200 steps, `save_every` 250 keeping 9
- `docs/krea2_field_template_2026_09.md` (new) — the template verbatim, the musubi→ai-toolkit translation table, the effective-LR arithmetic, the steps comparison, four open questions
- `ui/src/utils/stepSuggestion.ts` — corroboration block on `ARCH_HEURISTICS.krea2`, FIELD TEMPLATE paragraph on `ARCH_RECIPES.krea2`. Numbers unchanged
- `ui/src/server/builtinPresets.ts`, `presets/README.md`, `FORK_NOTES.md`, `PLAN.md` — registration, row, fork-only file entries, design entry
- Second pass, same day — the operator's DATASET half: doc sections 5-6 (Florence-2 `<DETAILED_CAPTION>` captioning, identity-attribute caption surgery, per-image alias triggers, `_facecrop` augmentation, checkpoint-selection method, plus a stage-by-stage gap table), preset to v1.1, `ARCH_RECIPES.krea2`'s caption note upgraded from single-source hypothesis to TWO-SOURCE, PLAN.md addendum

## Open
1. **CONTESTED, the live one: `timestep_type`.** Every Krea 2 preset here ships `linear` (LDS/RunComfy, "Krea-canonical"); musubi's own Krea 2 doc recommends `shift` at `discrete_flow_shift 2.5`, or its resolution-aware `krea2_shift`. This trainer already implements the latter as `timestep_type: shift` (`custom_flowmatch_sampler.py` "matches inference dynamic shifting" + krea2.py's exponential mu endpoints; upstream's 2026-09-16 `patch_size` fix made the token count right). One source each, and the field template does not record which its good runs used. Wants an A/B on one dataset — do not resolve it by argument
2. `python testing/test_presets.py` has NOT run against the new preset — the cloud container has no torch. Run it on the Windows box (`.\.venv\Scripts\python testing\test_presets.py`)
3. Batch size is absent from the recovered template. Everything in §3 of the doc assumes batch 1; if those were batch 2 on the H100, every passes/image figure doubles. Worth one question to the operator
4. NOT BUILT, scoped only (PLAN.md addendum 2026-09-19, doc section 6): the three prep stages this fork has no tool for — caption surgery (strip identity attributes / first sentence only / cut background clauses), per-image alias-set trigger selection, and `_facecrop` headshot augmentation. Florence-2 `<DETAILED_CAPTION>` is also absent from this UI's toolchain (upstream has it only in the standalone `flux_train_ui.py`). The operator offered to send their own scripts; they are self-described as barely working and one silently wrote no caption
5. Carried over from 2026-09-11: desktop SDXL/Illustrious effective batch 2 decision; measure batch 4 for Klein/Krea 2 on the 32 GB desktop (`batchAdvisor.ts` `DESKTOP32` cells); which Klein variant OOMs on the 16 GB laptop

## Decisions
- VAE question CLOSED (2026-09-19): musubi's `docs/krea2.md` specifies the Qwen-Image VAE + Qwen3-VL-4B-Instruct, identical to `arch: krea2` here. The template's "HunyuanVideo 3D causal VAE" is a carry-over from musubi's video heritage. Every step/LR transfer stands
- Staying on ai-toolkit (2026-09-19, operator's call): musubi wins a 12 GB floor (`--blocks_to_swap`), multi-GPU, exact `--resume` and more attention backends; none bind on a 5090, and switching would cost the GUI, the advisor, LoKr/DOP/Automagic. Comparison in the doc's section 7
- Ship 32/16 @ 2e-4 as a NEW preset rather than re-tuning the existing 32/32 @ 1e-4 ones — `alpha/rank × LR` makes them the same effective 1e-4, so this is a capacity choice, not an LR correction
- Advisor step tiers unchanged despite the template's flat 2200 — it agrees at 70 images (2240 vs 2200) and runs 2.3× hot at 30, and a flat count across a 2.3× size range is the shape the tiering replaced
- Recorded as an `UNVERIFIED on this trainer` preset, per the fork's usual honesty rule — the evidence is judged output, which is strong, but from a different implementation

## Traps
- `train.cache_text_embeddings: true` (this preset) is mutually exclusive with `train.diff_output_preservation`. Caption dropout still works cached — a blank embed is cached alongside (`toolkit/dataloader_mixins.py:2428`)
- `num_repeats` only duplicates the file list; the template's 10 repeats are epoch-bounded musubi accounting and inflate the advisor's file count if copied
- No new upstream touchpoints: every file changed here is fork-only, so the count stays 59
- Never push to `upstream`; its push URL stays the literal `DISABLED` (CLAUDE.md). Not present in a fresh clone — re-add fetch-only before any sync
- Commit identity is `socrasteeze <socradeez@gmail.com>`, author and committer, set per clone

## Verify
```
cd ui && npm ci && npx tsc --noEmit && npx tsc -p tsconfig.worker.json --noEmit && npx next build && npm test
python testing/test_presets.py          # needs torch; Windows box only
```
