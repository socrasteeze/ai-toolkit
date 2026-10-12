# Training Config Presets

Fork addition (see `FORK_NOTES.md`). Files in this folder appear in the **Presets** dialog
on the New Training Job page in the UI.

- Any ai-toolkit config works: UI JSON exports, CLI-style YAML from `config/examples/`, or
  configs shared by other users. Supported extensions: `.json`, `.jsonc`, `.yaml`, `.yml`.
- Loading a preset applies its training recipe (model, network, train, save, sample, and
  dataset *settings*) but keeps your current job name and dataset folder selections.
- Saving a preset from the UI strips machine-specific values (job name, dataset paths,
  training folder) so the file is shareable as-is.
- Missing fields are filled from the UI defaults on load, so partial configs are fine.
- The folder location can be overridden with a `PRESETS_FOLDER` row in the UI settings
  database; it defaults to `<repo>/presets`.

## Presets in this folder

| File | Recipe | Provenance |
|---|---|---|
| `anima_performance_gen_lora.json` / `anima_background_gen_lora.json` | Anima 2B, rank 32/32, adamw 2e-5 | Model author's own recipe (most authoritative here) |
| `flux_24gb_gen_lora.json` | FLUX.1-dev, 16/16, sigmoid, EMA 0.99 | Ostris' canonical train_lora_flux_24gb.yaml (v1.1 restores its EMA) |
| `illxl_char_lora.json` / `illxl_style_lora.json` | Illustrious-XL, 32/32 + conv 16/16 | Community consensus (optimizer contested — see notes) |
| `sdxl_char_lora.json` / `sdxl_style_lora.json` | SDXL, 32/32 + conv 16/16 | Community consensus |
| `sdxl_concept_lora.json` | SDXL concept, 16/8 | Ported from LoRA Dataset Studio's researched built-in |
| `krea2_16gb_automagic_char_lora.json` / `krea2_24gb_gen_lora.json` | Krea 2, 32/32 | Community (low-confidence — model is young) |
| `krea2_concept_lora.json` | Krea 2 concept, 32/16, linear | Extrapolated (no published recipe; LDS flags this too) |
| `krea2_char_lokr.json` | Krea 2 character **LoKr**, full-rank + `lokr_factor` 8, LR 5e-5, linear | New 2026-09-11 — LoKr reported to bleed identity far less than LoRA; factor CONTESTED (community 4 / middle 8 / one guide 16). UNVERIFIED here: no measured run |
| `krea2_char_lora.json` | Krea 2 character LoRA, 32/**16** (scale 0.5) @ LR **2e-4**, adamw8bit, bucketed multi-aspect, 2200 steps, latents + text embeds cached | New 2026-09-19 — the first Krea 2 preset here backed by runs judged on their OUTPUT rather than by a guide (recovered musubi-tuner template, `docs/krea2_field_template_2026_09.md`). Same effective LR as the 32/32 presets (`alpha/rank x LR` = 1e-4 for both), more capacity. Still musubi-sourced, not reproduced on this trainer |
| `krea2_5090_char_lora.json` | Krea 2 Raw character LoRA for the 32 GB RTX 5090: **no quantization** (transformer + TE bf16), 32/32 @ LR 1e-4 adamw8bit, EMA 0.98, **1024 only**, batch 1 x accum 1, 1800 steps, save every 250 keeping 100 (= all), 1024 sample prompts using `[trigger]` | New 2026-10-11 - COMMUNITY training reports (via LoRA Bot), NOT measured on this fork. Steps follow the community table 20 img ~1500 / 30 ~1800 / 50 ~2500 / 100 ~3500 (interpolate) - shipped as `meta.step_table`, which the Step Suggestion panel uses while this preset is loaded (v1.1, 2026-10-11); other Krea 2 presets keep the per-arch advisor. Automagic skipped: community says slower to converge on Krea 2. Unquantized bf16 transformer is ~26 GB, so fit on 32 GB at 1024 is UNVERIFIED - fall back to qfloat8 or layer offloading on OOM |
| `krea2_shift_char_lora.json` | A/B twin of the above: identical except `timestep_type: shift` | New 2026-09-19 — the EXPERIMENT for a contested setting, not a recommendation. LDS/RunComfy say linear is Krea-canonical; musubi-tuner's own `docs/krea2.md` recommends shift. This trainer's `shift` is the resolution-aware schedule (Krea's exponential mu endpoints, per sample), the equivalent of musubi's `krea2_shift`. Run both on one dataset and compare |
| `krea2_laptop_adamw_char_lora.json` | The field-proven character recipe on a 16 GB laptop: same rank 32/16 @ 2e-4, `layer_offloading` (35% transformer / 100% TE), sampling off, **512 not 1024** | New 2026-09-19 — memory/IO profile of `krea2_char_lora`, with the resolution drop called out as the one recipe-affecting deviation (512 and 1024 are both Krea 2 training resolutions; 1024 is the faithful reproduction if VRAM allows). UNMEASURED on 16 GB |
| `krea2_automagic_char_lora.json` | Third A/B twin: same 32/16, batch 1 x accum 1, but `automagic3` at the AUTHOR's rail shape (launch 1e-6, min 1e-8, max 1e-3, wd 0.0) | New 2026-09-19 — tests whether a self-adjusting LR lands near the field recipe's effective 1e-4 at the one effective batch where fused automagic costs nothing. Rails deliberately unlike the other `*_automagic` presets here, which cap `max_lr` at their launch LR and so can only adapt downward — that shape would make the experiment answer itself. UNMEASURED |
| `zimage_char_lora.json` / `zimage_style_lora.json` / `zimage_concept_lora.json` | Z-Image Turbo (`zimage:turbo` + training adapter), 32/32 char+style, 16/8 concept | Ported from LDS's researched built-ins. v1.1 (2026-08-29) fixes the arch: v1.0 trained the distilled Turbo weights under the base `zimage` arch without the adapter |
| `k4b_char_lora.json` | FLUX.2 Klein 4B, 16/16 char, sigmoid, 1500 steps | v1.2 (2026-09-11): rank 16 / LR 1e-4 / 1500 steps / 20-50 images are now BFL-PUBLISHED defaults, not an LDS extrapolation. Only the sigmoid timestep type is still unverified |
| `k4b_style_lora.json` | FLUX.2 Klein 4B style, 64/32 linear + 32/16 conv (4:2:2:1), weighted | Herbst 64-run sweep + BFL's official Klein style example, which runs the full 128/64/64/32 at LR 9.5e-5 / wd 1.5e-4. The half-scale fold is a deliberate 4B deviation (see docs/preset_alignment_2026_07.md 2026-07-21) |
| `k9b_char_lora.json` / `k9b_style_lora.json` | Klein 9B: char 16/16 @ 1500 steps; style raised to BFL's official 128/64 linear + 64/32 conv | v1.2 (2026-09-11) corrects the VRAM claim — the 9B is ~29 GB fp16 / ~15 GB fp8, so a single 24 GB card with quantization, not 32-48 GB. Not 9B-measured |
| (all Anima / illxl / k4b / k9b / Krea 2 presets) | `meta.step_table` dataset-size table (2026-10-12) | ONE machine-independent table per model, capped: Krea 2 1500/1800/2500/3000 at 20/30/50/75 (community), Anima 1500/2250/3000 at 20/30/40, illxl 1750/2500/3000 at 20/30/50 (community Illustrious guides), Klein 1200/1800/2400/2500 at 20/30/40/42 (BFL plateau). Past the cap point the gauge says the dataset is past the optimal size and to curate down; `krea2_5090_char_lora` keeps its community table. The Step Suggestion panel and exposure gauge follow the loaded preset's table |
| `k9b_laptop_char_lora.json` | Klein 9B character recipe (v1.1: rank raised to 32/32 to match Adam's earlier 9B runs + BFL complex-subject guidance, not A/B'd vs 16; @ 1e-4 adamw8bit, sigmoid, batch 1 x accum 1, 1500 steps) in the 16 GB laptop profile at **1024 only**: quantize + quantize_te (qfloat8 -> torchao float8 under offloading), low_vram, layer offloading TE 100% / transformer 80%, cached text embeddings + TE unloaded, RAM-served latents, sampling off (1024 `[trigger]` prompts pre-set), keep 10 checkpoints | New 2026-10-12 - COMMUNITY-DERIVED 16 GB settings (ostris #653/#669), NOT measured on the laptop. `meta.step_table` = the existing 9B rule (60/image, 1000-2500), so suggestions match the parent. OOM order and the Windows Sysmem Fallback tip are in the description. batchAdvisor treats batch 1 as UNMEASURED when layer_offloading is on |
| `k9b_laptop_char_lokr.json` | LoKr twin of `k9b_laptop_char_lora`: lokr, `lokr_full_rank` true, `lokr_factor` 8, linear 32/32 + conv 16/16 (overridden to full rank by `config_modules.py`), LR 5e-5; same 1024 / offload / caching / sampling / checkpoint / step table | New 2026-10-12 - COMMUNITY-DERIVED (Klein 9B LoKr reports), UNMEASURED. Factor 4 = more likeness at more memory; factor 16 is the OOM step |
| `*_automagic.json` (klein char, illustrious char, anima) | Parent recipe + `automagic3` with `min_lr`/`max_lr` rails, no scheduler, accum pinned to 1 | Rail pattern from `krea2_16gb_automagic_char_lora`; UNVERIFIED per arch (see PLAN.md 2026-07-19 + 2026-08-24) |
| `*_laptop16gb.json` (anima, flux, sdxl char, illustrious char, krea2; klein 9b has its own row above) | Parent recipe, memory/IO profile only — EXCEPT effective batch on the two SDXL-family ones (batch 1 + accum 2 vs the parents' effective 1) | Hardware tier for a 16 GB laptop GPU; see `docs/profiles.md`. The SDXL/Illustrious exception is deliberate (2026-07-29 batch discipline) and puts those presets in agreement with the advisor, which recommends batch 2 for that family; flux and krea2 laptop presets stay at effective 1 because `ARCH_RECIPES` recommends batch_size 1 for those archs. **Precision added 2026-09-19:** that is about `batch_size`. The machine-aware plan in `batchAdvisor.ts` is a separate component and will recommend reaching effective batch 2 (>=16 files) or 4 (>=40 Klein / >=47 Krea 2) on those same archs via `gradient_accumulation`, since accumulation is not VRAM-bound — `LAPTOP16.krea2` is a MEASURED `maxMicroBatch` of 1 ("batch 1 ran on the 16 GB laptop; batch 2 did not"), which caps batch_size, not the effective batch. So a krea2 laptop preset at effective 1 and an advisor suggesting accum 2 are not in conflict; the preset is the field recipe's own setting and the advisor is sizing for the dataset |

**Hardware profiles vs. recipes.** Most files here are *recipes* (rank/LR/optimizer/steps).
A few are *hardware profiles* that inherit a recipe unchanged and only change how it fits on
a given card: `anima_lora_{performance,background,5090_fast}` (32 GB desktop),
`krea2_16gb_automagic_char_lora`, and the `*_laptop16gb` set. Checkpoints are interchangeable across
profiles of the same recipe — you can resume a run under a different profile. One caveat
(2026-09-11): the two SDXL-family laptop profiles run effective batch 2 against their desktop
parents' 1, so resuming across that pair keeps the weights valid but changes exposure per step.

**Effective batch is gated on dataset size, not just VRAM** (2026-08-24). A preset's
`batch_size × gradient_accumulation` has to fit the card *and* be large enough not to trip the
advisor's step floor: below a per-arch file count the suggestion gets clamped up and real
per-image exposure runs into the fry band. Batch 4 needs ≥29 files on SDXL/Illustrious, ≥32 on
Anima, ≥40 on Klein, ≥47 on Krea 2. The two 32 GB Anima desktop profiles ship batch 4 for this
reason; the laptop and background profiles stay at 2. The step-suggestion panel names the safe
ceiling for your actual file count — trust it over the preset if they disagree.

Cross-repo recipe comparison: `docs/preset_alignment_2026_07.md`.
