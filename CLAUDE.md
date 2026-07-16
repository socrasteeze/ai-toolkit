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
  2: dataset analyzer + per-arch advisor. Phase 3: research-backed recipe overhaul. Phase 4:
  Anima 2B architecture port). Read the relevant phase before changing advisor/recipe logic —
  it records *why* numbers are what they are and which are still contested/unverified, not
  just what they are.

For anything Anima-related, also read `ANIMA_INTEGRATION_SPEC.md` (the original requirements
and gates — now all passed, kept as the historical record) and `docs/anima_delta_catalog.md`
(the A1 recon: architecture, training math, LoRA key format, and the user's resolved
decisions in §9).

## Fork hygiene rules (apply to any future change)

1. New functionality goes in new files. Upstream files should only ever get small,
   easy-to-reapply insertions (currently three files, all single JSX mounts:
   `ui/src/app/jobs/new/page.tsx`, `ui/src/app/jobs/new/SimpleJob.tsx`, and
   `ui/src/app/datasets/[datasetName]/page.tsx` — see `FORK_NOTES.md` for the exact
   lines).
2. No Prisma schema changes for fork features — presets are files on disk (`presets/`), not
   DB rows.
3. After any change, verify `git diff upstream/main --stat` still only shows the upstream
   files listed in `FORK_NOTES.md` (plus whatever new fork-only files you added).
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

## Anima 2B: upstream-native since 2026-07-16 (fork port SUNSET)

The fork's Phase 4 Anima port (vendored sd-scripts transformer, A1–A4 gates all passed
2026-07-12) was **retired on 2026-07-16** after upstream shipped its own diffusers-based
Anima support (ostris#860). `extensions_built_in/diffusion_models/anima/`,
`diffusion_models/__init__.py`, and `options.ts` are byte-identical to upstream again —
do not resurrect the port on future merges. Full history and the port→upstream
adaptation notes: `PLAN.md` Phase 4 ("Upstream Anima collision → fork port SUNSET").
The spec (`ANIMA_INTEGRATION_SPEC.md`) and gate artifacts (`docs/anima_delta_catalog.md`,
`docs/anima_a4_parity.md`, `docs/profiles.md`) describe the RETIRED port — historical
record only. TrainFlow retirement is the user's own task; leave
`W:\GitHub\Anima-TrainFlow` untouched.

What remains fork-side for Anima (all adapted to upstream's implementation):

- Presets `presets/anima_lora_{performance,background}.json` (v2.0) and
  `config/examples/train_lora_anima_2b.yaml` — the model author's recipe (rank 32,
  adamw 2e-5, adapter frozen) expressed in upstream's terms: diffusers-name
  `ignore_if_contains` list replacing sd-scripts' `["adaln_modulation"]`, and NO
  `sigmoid_scale` (upstream's implementation doesn't support it — don't re-add it to
  `model_kwargs`, it would be silently ignored). `background` (batch 1 + accum 4,
  low_vram) is the default for this shared 5090 machine.
- The advisor recipe in `stepSuggestion.ts` (`ARCH_RECIPES.anima`) — numbers unchanged,
  implementation-agnostic.
- `scripts/dump_lora_keys.py` — generic LoRA key dump/diff tool; outlived the port.
- Existing sd-scripts-format LoRAs still load (upstream converts on load); new exports
  use upstream's comfy-style keys.
- Training env: repo `.venv` (torch 2.10+cu130 + `requirements.txt`). Upstream's Anima
  needs the diffusers commit pinned in `requirements_base.txt` — reinstall requirements
  before the first Anima run after the sunset.
- Workstream B QoL tools: `scripts/preflight.py` (B1), `scripts/auto_caption.py` (B2,
  WD14 tagger, deps in `scripts/requirements-qol.txt`), `scripts/smart_prep.py` (B3,
  U2Net crop, same deps), the existing `stepSuggestion.ts` advisor (B4), and the
  `DatasetTools.tsx` panel (B5, wraps B1–B3 via `api/datasets/tools` +
  `server/datasetTools.ts`). B5's pre-flight is **advisory-only by deliberate
  decision** — do not wire it to block job submission without revisiting PLAN.md's
  B5 note (that would touch upstream's job-start route).
