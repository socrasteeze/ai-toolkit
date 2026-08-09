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
   easy-to-reapply insertions. As of 2026-08-09 that is **16 files** — get the current
   list with `git diff upstream/main --name-status | grep -v '^A'`, and the per-file
   change + conflict-resolution notes from `FORK_NOTES.md`'s "Upstream files modified"
   table (the authoritative record; this count goes stale, that table does not).
   **That command only answers correctly when this fork is NOT behind upstream.**
   It diffs HEAD against `upstream/main`, so while you are behind, every file
   *upstream* changed and the fork never touched is reported as a fork
   modification too. Measured 2026-08-09, five commits behind: it said 22, six of
   which were upstream's own. That is precisely when a sync makes you reach for
   it. Either `git fetch upstream` and check `git rev-list --count HEAD..upstream/main`
   is 0 first, or ask the question that does not care:

   ```bash
   git diff $(git merge-base HEAD upstream/main)..HEAD --name-status | grep -v '^A'
   ```

   Both forms give 16 once the fork is level; only the second is trustworthy
   mid-sync. Rule 3 below runs *after* the merge, so the short form is fine there.
   The three original JSX mounts (`ui/src/app/jobs/new/page.tsx`,
   `ui/src/app/jobs/new/SimpleJob.tsx`, `ui/src/app/datasets/[datasetName]/page.tsx`)
   are still the most conflict-prone.
2. No Prisma schema changes for fork features — presets are files on disk (`presets/`), not
   DB rows.
3. After any change, verify `git diff upstream/main --stat` still only shows the upstream
   files listed in `FORK_NOTES.md` (plus whatever new fork-only files you added).
4. Update `FORK_NOTES.md`'s file list and `PLAN.md`'s relevant phase in the same commit as
   the code change — don't let them drift, they're the handoff mechanism for the next
   session/agent.

## Upstream syncs

Standing instructions for `/sync-upstream` (or any "pull in upstream" request):

1. **The `upstream` remote is not committed** and does not survive a fresh clone, so a new
   session/container will find only `origin`. Add it first, then immediately make it
   fetch-only:
   `git remote add upstream https://github.com/ostris/ai-toolkit.git`
   `git remote set-url --push upstream DISABLED`
   The second line is not optional — nothing here ever pushes to `ostris/ai-toolkit`, and
   git has no real "no push URL" state, so a remote with only a fetch URL happily pushes
   to *that*. The bogus placeholder makes a stray `git push upstream` fail locally before
   it touches the network. Leave it in place; do not "fix" it back to a real URL. Same
   threat as rule 2 below (never PR upstream), different mechanism.
2. **NEVER open a pull request for a sync — push straight to `main`.** No PR, no review
   branch, no exceptions. Standing permission from the user (2026-07-25); it applies to
   upstream syncs specifically, not to feature work. Syncs have always been fast-forwards
   of `main`; if one ever wouldn't be, stop and ask rather than force-pushing.

   **And never open a PR against `ostris/ai-toolkit` (upstream) for any reason.** This
   fork's changes are personal — presets, `.bat` launchers, the advisor, the QoL scripts —
   and are not offered upstream. A previous agent did this and it publicly proposed the
   user's personal config to the upstream maintainer. Do not repeat it.

   The trap is that GitHub **defaults a PR's base to the parent repo** when you push a
   branch from a fork, so "just open a PR" silently targets `ostris/ai-toolkit` rather than
   `socrasteeze/ai-toolkit`. `gh`/API calls have the same default. Since syncs never need a
   PR at all, the safe rule is simply: don't create one. If the user ever explicitly asks
   for a PR on fork work, set the base to `socrasteeze/ai-toolkit` and confirm the target
   with them before creating it.
3. Follow `FORK_NOTES.md`'s sync procedure for the merge itself, then verify the fork's
   insertion points survived (grep for the mounts listed in its file table) and that
   `git diff upstream/main --stat` still shows only the expected files.
4. Validate before pushing: `npm ci` + `npx tsc --noEmit` + `npx next build` in `ui/`, and
   `python3 -m py_compile` on any touched Python. Note in the report what the build can't
   cover (runtime-only paths like the cron worker, and anything needing a GPU).

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
- **Effective batch (batch_size × gradient_accumulation) is capped at 2 across every recipe
  and preset** (2026-07-29, operator decision backed by their own runs). This is deliberate
  and must not be "corrected" back to the batch 4 most community guides quote. Reason:
  `suggestSteps()` divides by effective batch and then clamps to the arch's `minSteps`
  floor — at effective batch 4 that quotient falls under the floor for any small/medium
  dataset, gets clamped back up, and silently inflates real per-image exposure 2–3× past
  the arch target, so the advisor recommends a step count its own exposure gauge would
  flag as fry-risk. It also overrides the Anima author's published effective batch 4;
  that deviation is flagged in-place in the recipe notes and preset descriptions rather
  than hidden. See PLAN.md's 2026-07-29 entry for the numbers.
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
  `model_kwargs`, it would be silently ignored). `background` (batch 1 + accum 2,
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

## Local tooling notes

- `build_and_push_docker` pushes to `socrasteeze/aitoolkit` on Docker Hub, not
  `ostris/aitoolkit` — fork-specific, deliberate (2026-07-31).
- `hf-cache/` (local HuggingFace cache, several GB) is gitignored — it's runtime cache,
  never commit it back.
