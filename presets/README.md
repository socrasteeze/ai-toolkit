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
| `anima_lora_performance.json` / `anima_lora_background.json` | Anima 2B, rank 32/32, adamw 2e-5 | Model author's own recipe (most authoritative here) |
| `flux_lora_24gb.json` | FLUX.1-dev, 16/16, sigmoid, EMA 0.99 | Ostris' canonical train_lora_flux_24gb.yaml (v1.1 restores its EMA) |
| `illustriousxl_character_lora.json` / `illustriousxl_style_lora.json` | Illustrious-XL, 32/32 + conv 16/16 | Community consensus (optimizer contested — see notes) |
| `sdxl_character_lora.json` / `sdxl_style_lora.json` | SDXL, 32/32 + conv 16/16 | Community consensus |
| `sdxl_concept_lora.json` | SDXL concept, 16/8 | Ported from LoRA Dataset Studio's researched built-in |
| `krea2_lora_16gb.json` / `krea2_lora_low_vram.json` | Krea 2, 32/32 | Community (low-confidence — model is young) |
| `krea2_concept_lora.json` | Krea 2 concept, 32/16, linear | Extrapolated (no published recipe; LDS flags this too) |
| `zimage_character_lora.json` / `zimage_style_lora.json` / `zimage_concept_lora.json` | Z-Image, 32/32 char+style, 16/8 concept | Ported from LDS's researched built-ins |
| `flux2_klein_character_lora.json` | FLUX.2 Klein 4B, 16/16 char, sigmoid | UNVERIFIED — LDS extrapolation, nothing Klein-specific published |
| `flux2_klein_style_lora.json` | FLUX.2 Klein 4B style, 64/32 linear + 32/16 conv (4:2:2:1), weighted | Herbst 64-run sweep + BFL official Klein example (LDS ships 128/64/64/32; ATK folds to half scale — see docs/preset_alignment_2026_07.md 2026-07-21) |

Cross-repo recipe comparison: `docs/preset_alignment_2026_07.md`.
