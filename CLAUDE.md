# CLAUDE.md

This is a personal fork of [ostris/ai-toolkit](https://github.com/ostris/ai-toolkit) (a
diffusion LoRA/fine-tuning trainer with a Next.js UI). The fork adds personal-use features
on top of upstream without modifying upstream's training code.

**Read these two files before touching anything in this repo:**

- `FORK_NOTES.md` — the authoritative, always-current list of every place the fork diverges
  from upstream (which files are fork-only vs. upstream-modified, and the exact insertion
  points in the latter). This is what keeps `git merge upstream/main` a two-minute job —
  update it whenever a change adds a new upstream touchpoint or a new fork-only file.
- `PLAN.md` — the design history, phase by phase (Phase 1: presets + step suggestion. Phase
  2: dataset analyzer + per-arch advisor. Phase 3: research-backed recipe overhaul). Read the
  relevant phase before changing advisor/recipe logic — it records *why* numbers are what
  they are and which are still contested/unverified, not just what they are.

## Fork hygiene rules (apply to any future change)

1. New functionality goes in new files. Upstream files should only ever get small,
   easy-to-reapply insertions (currently: one import + one JSX mount line each in
   `ui/src/app/jobs/new/page.tsx` and `ui/src/app/jobs/new/SimpleJob.tsx` — see
   `FORK_NOTES.md` for the exact lines).
2. No Prisma schema changes for fork features — presets are files on disk (`presets/`), not
   DB rows.
3. After any change, verify `git diff upstream/main --stat` still only shows the two
   upstream files listed in `FORK_NOTES.md` (plus whatever new fork-only files you added).
4. Update `FORK_NOTES.md`'s file list and `PLAN.md`'s relevant phase in the same commit as
   the code change — don't let them drift, they're the handoff mechanism for the next
   session/agent.

## Current state of the training advisor (`ui/src/utils/stepSuggestion.ts`)

This is the most actively-evolving part of the fork, so it's worth a specific note here on
top of `PLAN.md`'s Phase 3 section:

- Recipes (`ARCH_RECIPES`) are **not fixed per architecture** — they're keyed by dataset-size
  tier (`getSizeTier()`: small/medium/large by image count) because smaller datasets need
  lower rank/LR to avoid overfitting, per current community guides.
- `model.arch` alone cannot distinguish Illustrious-XL / Pony Diffusion from vanilla SDXL —
  all three report `arch: "sdxl"`. Detection is done by substring-matching
  `model.name_or_path` (`illustriousOrPonyRecipe()`). If you add support for another
  checkpoint family that shares an arch key with something else, follow this same pattern
  rather than trying to add a new arch string that the trainer doesn't actually have.
- Several recommended values are explicitly flagged in the `notes` field as low-confidence or
  genuinely contested in the source guides (e.g. Illustrious optimizer choice, Pony's
  `score_9` caption tag, all Flux2/Flux2-Klein numbers, which are FLUX.1 proxies). Do not
  quietly "resolve" these to a single confident number without new research backing it — the
  honesty about uncertainty is intentional, not a TODO to clean up.
- The LR scheduler (`lr_scheduler`) has no dedicated UI field anywhere else in this app; the
  advisor's Apply button is currently the only way a user sets it from the UI. If a proper
  scheduler dropdown is ever added to the main form, keep the advisor's suggestion in sync
  with it rather than fighting it.
