// Fork-only file (see FORK_NOTES.md). The presets shipped with the fork (tracked in git
// + cross-referenced by docs/preset_alignment_2026_07.md and presets/README.md).
//
// Used to flag them in the Presets dialog so the UI warns before overwriting a
// provenance-tracked recipe with the current form, and by the POST route to refuse an
// accidental overwrite that did not come through that dialog's explicit Overwrite flow.
//
// No imports on purpose: `presetsPath.ts` reaches Prisma, so this set lives in its own
// module where `ui/tests/builtinPresets.test.mjs` can assert it equals the git-tracked
// `presets/*.json` basenames without loading a query engine. That test is the reason this
// list can no longer silently go stale (it was five presets behind on 2026-08-29).
// Names are the sanitized basename (no extension), matching what the GET/POST routes report.
export const BUILTIN_PRESET_NAMES = new Set<string>([
  'anima_lora_5090_fast',
  'anima_lora_automagic',
  'anima_lora_background',
  'anima_lora_laptop16gb',
  'anima_lora_performance',
  'flux2_klein_9b_character_lora',
  'flux2_klein_9b_style_lora',
  'flux2_klein_character_lora',
  'flux2_klein_character_lora_automagic',
  'flux2_klein_style_lora',
  'flux_lora_24gb',
  'flux_lora_laptop16gb',
  'illustriousxl_character_lora',
  'illustriousxl_character_lora_automagic',
  'illustriousxl_character_lora_laptop16gb',
  'illustriousxl_style_lora',
  'krea2_concept_lora',
  'krea2_lora_16gb',
  'krea2_lora_laptop16gb',
  'krea2_lora_low_vram',
  'sdxl_character_lora',
  'sdxl_character_lora_laptop16gb',
  'sdxl_concept_lora',
  'sdxl_style_lora',
  'zimage_character_lora',
  'zimage_concept_lora',
  'zimage_style_lora',
]);

export const isBuiltinPreset = (name: string): boolean => BUILTIN_PRESET_NAMES.has(name);
