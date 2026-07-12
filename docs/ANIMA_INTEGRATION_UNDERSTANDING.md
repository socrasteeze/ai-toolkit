# Understanding: Anima 2B Integration Spec

Companion to `ANIMA_INTEGRATION_SPEC.md` (repo root). This records what the agent understood
from the spec before any work began — written 2026-07-12, no spec work executed yet.

## The goal in one sentence

Make this ai-toolkit fork the single trainer for SDXL/Illustrious, FLUX.2 Klein 4B/9B,
Krea 2, **and Anima 2B** (the one missing arch), port Anima-TrainFlow's QoL tooling over,
ship headroom-aware training profiles, then retire TrainFlow to reference-only.

## Hard constraints I registered

1. **sd-scripts key naming on export is non-negotiable** (A3 hard gate). ComfyUI/SwarmUI's
   Anima loader expects sd-scripts keys; a toolkit-trained LoRA must produce a zero-mismatch
   key/shape diff against a known-good TrainFlow LoRA. If toolkit-native naming differs,
   remap on export — and keep an automated check so refactors can't regress it.
2. **TrainFlow's modified sd-scripts is the source of truth** for anything touching Anima
   training math or export format. Toolkit conventions lose ties unless explicitly overridden.
3. **No redline tuning.** The 5090/32 GB box is shared with other work. Every arch gets two
   preset profiles: `performance` (use the hardware) and `background` (≤ ~60–70% VRAM,
   9–12 GB free, smaller batch + grad accumulation, capped workers, caching on —
   default for Anima/SDXL). Hardware tuning lives in presets only, never in model classes.
4. **Fork hygiene still applies** (per `CLAUDE.md`/`FORK_NOTES.md`): new functionality in new
   files, extension pattern (`extensions_built_in/`) for the model, minimal upstream edits,
   keep mergeable with `ostris/ai-toolkit`.
5. **Gates produce artifacts, not assertions**: delta catalog doc, key-diff output,
   loss-curve comparison, VRAM measurement.
6. **Ask before**: changing LoRA export format, altering shared/core toolkit code, or adding
   heavyweight dependencies.
7. **Windows is the deployment target** for scripts and paths.

## Execution order as I understand it

| Order | Item | Gate |
|---|---|---|
| 1 | A1 recon: delta catalog of TrainFlow's sd-scripts mods → `docs/anima_delta_catalog.md` | Review checkpoint — present findings **before** writing model code |
| 2 | A2 `AnimaModel` extension (pattern: Chroma / Lumina2 / Qwen-Image) + config example + preset + UI registration | End-to-end LoRA run completes (quality irrelevant) |
| 3 | A3 export key parity via `scripts/dump_lora_keys.py` | **HARD GATE**: zero key/shape diff + user confirms Comfy/Swarm load |
| 4 | A4 quality parity: matched-hyperparameter run vs TrainFlow, incl. Prodigy behavior check | Loss curves / samples comparable |
| 5 | B1–B4 QoL CLI tools (`preflight.py`, `auto_caption.py`, `smart_prep.py`, step suggestion) — may start in parallel with A2+ | — |
| 6 | C profiles (`presets/<arch>_{performance,background}.yaml` + `docs/profiles.md`) | Measured VRAM under target in a live `background` run |
| 7 | B5 UI "Dataset Tools" panel (optional, only after CLIs are stable) | — |
| 8 | Retire TrainFlow (README → reference-only, link here) | — |

## How this intersects the fork's existing state (important reconciliation)

Parts of Workstream B **already exist in this fork as UI features**, ported from TrainFlow's
briefs during PLAN.md Phases 1–3:

- **B4 (step/schedule suggestion)** largely overlaps `ui/src/utils/stepSuggestion.ts` — it
  already has per-arch, dataset-size-tiered recipes (and deliberate low-confidence flags that
  must not be silently "resolved"). The spec's "port TrainFlow's suggest-steps logic, CLI
  first" should be read as *extend/reconcile with* the existing TS implementation, not build
  a competing one. Anima needs adding to `ARCH_RECIPES` once its arch key exists.
- **B1 partially overlaps** the existing dataset analyzer
  (`ui/src/app/api/datasets/analyze/route.ts` + `StepSuggestion.tsx` panel): caption
  coverage and dimension checks exist in the UI; the missing piece is a CLI pre-flight that
  can block queue submission.
- B2 (WD14 auto-caption) and B3 (U2Net smart prep) are genuinely new here.

The "CLI first, UI second" ordering in the spec was written without knowledge that the UI
half-exists; when B-work starts, decide per-tool whether CLI wraps the same logic or the UI
calls the CLI. Flag this at the A1 review checkpoint.

## Inputs needed from the user before certain steps

- Local path (or clone access) to `socrasteeze/Anima-TrainFlow` for A1 recon.
- A **known-good TrainFlow-trained Anima LoRA** safetensors file for the A3 key diff.
- A small test dataset for the A2 end-to-end run and the A4 parity run.
- Manual confirmation steps: A1 catalog review, A3 Comfy/Swarm load test.

## Status

Nothing executed. Next action when work begins: **A1 recon** — locate TrainFlow's sd-scripts
base version and produce `docs/anima_delta_catalog.md`, then stop for review.
