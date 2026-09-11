# HANDOFF

**Updated:** 2026-09-11 · **Branch:** main · **Base:** 5effd11 (delivery tip; this file's commit sits on top) · **Tree:** clean

## State
Klein/Krea 2 recipe review delivered to main: seven commits, all gates green in the container. No run has been made against any adopted number — every value is published guidance or the operator's own batch/VRAM measurements.

## Done this session
- Klein 4B/9B: BFL guidance ratified LR 1e-4 / rank 16; VRAM claims corrected (4B 12-16 GB class, 9B 24 GB); character steps 2500 -> 1500; explicit `ARCH_HEURISTICS` entries with ceiling 2500 — `ui/src/utils/stepSuggestion.ts`, `presets/flux2_klein_*.json`
- Krea 2: numbers confirmed by an independent ai-toolkit wrapper; LoKr added as `presets/krea2_character_lokr.json` (factor 8, LR 5e-5)
- Automagic v3 re-read against `toolkit/optimizers/automagic3.py`: rails re-framed as optional, `polarity_history` named, LoKr factor doc direction fixed in `ui/src/forkDocs.tsx`
- Machine-aware batch plan from the operator's measured VRAM table — `ui/src/utils/batchAdvisor.ts`, mounted in `ui/src/components/StepSuggestion.tsx`, tests in `ui/tests/batchAdvisor.test.mjs`
- Laptop-tier effective-batch question resolved: presets right, `docs/profiles.md` and `presets/README.md` sentences fixed

## Open
1. Decide whether the desktop SDXL/Illustrious presets move to effective batch 2 to match the advisor — `presets/sdxl_character_lora.json`, `presets/illustriousxl_character_lora.json` (PLAN.md Addendum 4)
2. Run the Python preset gate on the Windows box; it needs torch and could not run in the container — `.\.venv\Scripts\python testing\test_presets.py`
3. Measure batch 4 on the 32 GB desktop for Klein and Krea 2, then flip the two `DESKTOP32` cells in `ui/src/utils/batchAdvisor.ts`
4. Record which Klein variant OOMs on the 16 GB laptop (operator could not recall); `LAPTOP16.flux2_klein` treats 4B and 9B alike until then
5. Optional, offered not built: an `OptimizerHint` advisory for adafactor on Klein 9B character training (single-source collapse report, PLAN.md Addendum 1)
6. Optional, offered not built: an automagic variant preset with the author's rail shape (launch 1e-6, `max_lr` 1e-3) to A/B against `krea2_lora_16gb`

## Decisions
- Klein 4B style stays 64/32 + 32/16 over BFL's 128/64/64/32 — a 4B judgment, now labelled a deliberate deviation; the 9B style preset took the official numbers
- Klein character presets 1500 steps over 2500 — BFL's published starting point; advisor ceiling 2500 over the inherited FLUX.1 3000
- Krea 2 LoKr factor 8 over 4 or 16 — the stated community middle; in LyCORIS a LOWER factor is a LARGER network
- Automagic rails kept at `max_lr` = launch LR over the author's overflow-guard defaults — operator's shared-machine ceiling; the notes now say it is one-directional
- Batch route: `batch_size` on 32 GB, `gradient_accumulation` on 16/24 GB, over one rule for all — measured VRAM plus the per-micro-batch `empty_cache()` under `low_vram`
- Laptop effective-batch: fixed the docs, kept the presets — every preset matches its arch's advisor batch recommendation
- kWh column left out of the batch table — operator's call
- Fast-forward merge over squash — the commit messages carry the research provenance PLAN.md points at

## Traps
- `testing/test_presets.py` and the other Python suites need torch; the cloud container has neither torch nor pytest. Interpreter on the Windows box is `python`, never `python3`
- Fused Automagic + `gradient_accumulation` > 1 hard-errors at config parse; the batch plan routes around it, a hand edit does not
- `ARCH_HEURISTICS.flux2_klein_*` must keep `stepsPerItem` 60 — the >=40-file batch-4 threshold is pinned by `ui/tests/stepSuggestion.test.mjs` and quoted in `presets/README.md`
- `VRAM_TABLE.mid24` mirrors `laptop16` cell for cell and a test pins the equality; change both or the test fails
- `num_repeats` only duplicates the file list; kohya/musubi repeat advice does not transfer to this step-bounded trainer
- Never push to `upstream`; its push URL stays the literal `DISABLED` (CLAUDE.md). Not present in a fresh clone — re-add fetch-only before any sync

## Verify
```powershell
# one shot, from the repo root on the Windows box
.\scripts\run_fork_tests.ps1

# or individually
Set-Location ui; npm ci; npx tsc --noEmit; npx next build; npm test; Set-Location ..
.\.venv\Scripts\python scripts\verify_fork.py
.\.venv\Scripts\python testing\test_presets.py
```
