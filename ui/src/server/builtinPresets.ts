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
  'anima_5090_fast_gen_lora',
  'anima_automagic_gen_lora',
  'anima_background_gen_lora',
  'anima_laptop_gen_lora',
  'anima_performance_gen_lora',
  'flux_24gb_gen_lora',
  'flux_laptop_gen_lora',
  'illxl_automagic_char_lora',
  'illxl_char_lora',
  'illxl_laptop_char_lora',
  'illxl_style_lora',
  'k4b_automagic_char_lora',
  'k4b_char_lora',
  'k4b_style_lora',
  'k9b_char_lora',
  'k9b_laptop_char_lokr',
  'k9b_laptop_char_lora',
  'k9b_style_lora',
  'krea2_16gb_automagic_char_lora',
  'krea2_24gb_gen_lora',
  'krea2_5090_char_lora',
  'krea2_automagic_char_lora',
  'krea2_char_lokr',
  'krea2_char_lora',
  'krea2_concept_lora',
  'krea2_laptop_adamw_char_lora',
  'krea2_laptop_automagic_char_lora',
  'krea2_shift_char_lora',
  'sdxl_char_lora',
  'sdxl_concept_lora',
  'sdxl_laptop_char_lora',
  'sdxl_style_lora',
  'zimage_char_lora',
  'zimage_concept_lora',
  'zimage_style_lora',
]);

export const isBuiltinPreset = (name: string): boolean => BUILTIN_PRESET_NAMES.has(name);
