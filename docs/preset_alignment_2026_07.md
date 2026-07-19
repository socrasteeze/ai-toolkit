# Training-preset alignment: LDS built-ins vs the ai-toolkit fork (2026-07)

Cross-check of the two places this stack encodes LoRA training recipes:

- **LDS** — the fifteen built-in researched presets
  (`backend/app/services/lora_training.py` `BUILTIN_TRAIN_PRESETS` +
  `backend/app/routes/training.py` `_STYLE_BUILTIN_PRESETS`), the family
  defaults, and the adaptive step policies.
- **ATK** — the ai-toolkit fork's `presets/*.json` and the dataset-size-tiered
  advisor (`ui/src/utils/stepSuggestion.ts` `ARCH_RECIPES` / `ARCH_HEURISTICS`).

A copy of this report lives in both repos (this file in the ai-toolkit fork;
the canonical copy in lora-dataset-studio `docs/preset-alignment-2026-07.md`).
Follow-up shipped with this report: ATK gained LDS-derived presets for the
families/kinds it lacked (Z-Image, FLUX.2 Klein, and the Concept kind), advisor
timestep notes, and the FLUX.1 EMA fidelity fix — see "What was synced" at the
end. **No existing number on either side was changed.**

## 1. Structural differences (system level)

| Dimension | LDS | ATK |
|---|---|---|
| Preset payload | rank, alpha, resolution, cadence, sample prompts, sometimes timestep/EMA. LR, optimizer, scheduler, batch, quantization come from family defaults. | Complete job configs (every key explicit). |
| Family defaults | lr 1e-4, adamw8bit, scheduler constant, batch 1, grad-accum 1, qfloat8 + low_vram (except SDXL: unquantized). | Per preset; advisor states optimizer in notes. |
| Dataset-size awareness | None — one recipe per family+kind regardless of image count. | Advisor tiers: small <30, medium <150, large 150+ images. |
| Steps | Adaptive per kind: Character n×120 clamped [1500, 3500]; Concept 475×sqrt(n) clamped [2000, 12000]; Style 50/img with family envelopes (Klein [1200,3000], Krea raw [2000,3000], turbo [1000,2000], Z-Image turbo [1000,2000], others [1500,3000]). | Fixed steps per preset (2000–3000); advisor steps-per-image heuristics (sdxl 100, flux 60, krea2 65, wan 100...) clamped per arch. |
| Conv LoRA layers | Never emitted. | SDXL/Illustrious presets set conv 16 / conv_alpha 16. |
| content_or_style | Not set (trainer default). | Set: balanced (character), style (style presets). |
| Caption dropout | 0.05 everywhere; Style-on-Krea forced to 0.0 (frozen text-embed cache makes post-cache dropout ineffective). | 0.05 character/flux/krea, 0.1 style presets, 0 anima. |
| Kinds covered | Character, Concept, Style per family. | Character + Style presets; **no Concept presets** (filled by this sync). |
| Families covered | Z-Image, SDXL, Krea 2, FLUX.1, FLUX.2 Klein. | SDXL, Illustrious, FLUX.1, Krea 2, Anima (+ advisor: sd15, Pony, Qwen-Image, Z-Image, Klein 4B/9B, flex/chroma). |

## 2. Family-by-family verdicts

### SDXL — DIVERGES (alpha philosophy + conv + batch/scheduler)

| Source | rank/alpha | conv | batch | scheduler | dropout | steps |
|---|---|---|---|---|---|---|
| LDS character | 32/16 (half-alpha "deliberate valid choice") | – | 1 | constant | 0.05 | ~120/img [1500,3500] |
| ATK preset character | 32/32 | 16/16 | 1 | constant | 0.05 | 2500 |
| ATK advisor medium | 32/32 | – | 4 | cosine | – | 100/img [1200,4000] |
| LDS style | 32/32 (full alpha "recommended for style") | – | 1 | constant | 0.05 | 50/img [1500,3000] |
| ATK preset style | 32/32 | 16/16 | 1 | constant | 0.1 | 3000 |

Verdict: style rank/alpha aligned; character alpha differs by philosophy
(half-alpha at LDS, full at ATK — both defensible, both sourced); ATK trains
conv layers LDS never touches; the advisor's batch-4 + cosine has no LDS
counterpart (LDS is hardwired batch 1). Style dropout differs (0.05 vs 0.1).

### FLUX.1 — BEST ALIGNED (one fidelity gap, fixed)

Both sides derive from Ostris' canonical `train_lora_flux_24gb.yaml`: rank
16/16, sigmoid timesteps, adamw8bit, lr 1e-4, qfloat8. LDS ships EMA 0.99 (in
the canonical yaml, "recommended to leave on"); ATK's `flux_lora_24gb.json`
had dropped it — **fixed in this sync** (fidelity to the mirrored source, not a
contested value). The ATK *advisor's* flux row (medium 32/16, constant) is a
different, alpha-below-rank school — reported, untouched.

### Krea 2 — ALIGNED (both flagged low-confidence)

LDS char/style 32/32 + linear timestep + adamw8bit + qfloat8/low_vram ==
ATK `krea2_lora_low_vram.json` exactly; advisor medium/large 32/32 agrees.
`krea2_lora_16gb.json` (automagic3, 512 res, layer offloading) is a 16 GB
hardware profile, not a recipe conflict. Both sides carry an explicit
low-confidence flag on Krea numbers (thin sources, model ~6 weeks old at
research time). LDS's Krea *concept* 32/16-linear is an LDS extrapolation (no
published recipe exists) — synced to ATK as a flagged preset.

### FLUX.2 Klein — COMPATIBLE, EVERYTHING FLAGGED

LDS character 16/16-sigmoid and style 32/32-weighted sit exactly at the ends of
the advisor's tier ramp (small 16/16 → large 32/32, FLUX.1-proxy, "unverified").
Timestep guidance exists only on the LDS side (sigmoid char / weighted style,
itself flagged as extrapolated). Both sides agree nothing Klein is verified yet.
Synced to ATK as flagged presets + advisor notes.

### Z-Image — ALIGNED at medium/large; size-tier gap at small

LDS char/style 32/32 == advisor medium/large 32/32. The advisor's small tier
(16/16 under 30 images) has no LDS counterpart — LDS always ships 32/32 for
character even on a 20-image set (its own note: "lower-regret for hard faces").
Timestep split (sigmoid subjects / weighted style+concept) is LDS-side only —
synced into the advisor notes. LDS concept 16/8-weighted synced as a preset.

### No counterpart (nothing to compare)

- ATK-only: Illustrious (64/32, lr 3e-4, constant), Pony (32/16, 3e-4, cosine),
  Anima (32/32, plain adamw 2e-5 — the model author's own recipe, most
  authoritative number in either repo), sd15, Qwen-Image, wan. LDS has no such
  training families (Anima/Illustrious are on its roadmap).
- LDS-only: the whole Concept kind (inverted captions, alpha = rank/2, 475sqrt(n)
  steps) — ATK had no concept presets at all; filled by this sync.

## 3. Contested / do-not-resolve list (deliberately untouched, both repos)

- Illustrious optimizer (Prodigy+cosine vs adamw8bit+constant camps).
- Pony `score_9` caption tag.
- Every FLUX.2 Klein number on both sides (FLUX.1 proxies / extrapolations).
- Krea 2 scheduler (no source states one) and the Krea2 step heuristic
  (community guesswork; over-warns on 250+ image sets).
- LDS's Klein sigmoid-for-character and its concept-krea / concept-klein
  recipes (explicitly extrapolated).
- SDXL character alpha: 32/16 (LDS) vs 32/32+conv (ATK) — two sourced schools;
  pick per run, don't harmonize blindly.

## 4. If you reconcile further, later

- Size tiers are the advisor's real edge — porting the <30-image tier idea into
  LDS presets would be the highest-value convergence.
- Conv 16/16 for LDS SDXL presets (ATK and most SDXL guides train conv).
- Style caption-dropout: pick 0.05 or 0.1 and use it on both sides.
- LDS's per-kind step formulas would make good advisor note material beyond the
  arch heuristics.

## 5. What was synced into ATK with this report

- New presets (LDS-derived, provenance + flags in each `meta.description`):
  `zimage_character_lora.json`, `zimage_style_lora.json`,
  `zimage_concept_lora.json`, `flux2_klein_character_lora.json`,
  `flux2_klein_style_lora.json`, `krea2_concept_lora.json`,
  `sdxl_concept_lora.json`.
- `flux_lora_24gb.json`: EMA 0.99 restored (canonical-yaml fidelity).
- `stepSuggestion.ts`: timestep-guidance sentences appended to the zimage,
  krea2 and flux2_klein notes (numbers untouched).
- Base models in the new presets match what LDS launches:
  `Tongyi-MAI/Z-Image-Turbo`, `krea/Krea-2-Raw`,
  `black-forest-labs/FLUX.2-klein-base-4B` (9B: swap arch to `flux2_klein_9b`
  and the path to `...-9B`), `stabilityai/stable-diffusion-xl-base-1.0`.
- Steps in the new presets are fixed midpoints of LDS's adaptive policies
  (character/style 2500, concept 3000) — LDS itself computes them per dataset
  size at launch.
