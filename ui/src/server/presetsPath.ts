import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import NodeCache from 'node-cache';
import { TOOLKIT_ROOT } from '@/paths';

// Fork-only file (see FORK_NOTES.md). Mirrors the getDatasetsRoot() pattern in
// ./settings.ts, but kept separate so upstream changes to settings.ts never conflict.
// Short TTL so a PRESETS_FOLDER settings change is picked up without a restart.
const myCache = new NodeCache({ stdTTL: 60 });
const prisma = new PrismaClient();

export const defaultPresetsFolder = path.join(TOOLKIT_ROOT, 'presets');

export const presetExtensions = ['.json', '.jsonc', '.yaml', '.yml'];

// The presets shipped with the fork (tracked in git + cross-referenced by
// docs/preset_alignment_2026_07.md). Used only to flag them in the Presets dialog
// so the UI warns before overwriting a provenance-tracked recipe with the current
// form — it never blocks the write. Keep in sync with the files in presets/ that
// ship in the repo; a user-saved preset is anything NOT in this set. Names are the
// sanitized basename (no extension), matching what the GET/POST routes report.
export const BUILTIN_PRESET_NAMES = new Set<string>([
  'anima_lora_5090_fast',
  'anima_lora_background',
  'anima_lora_performance',
  'flux2_klein_character_lora',
  'flux2_klein_style_lora',
  'flux_lora_24gb',
  'illustriousxl_character_lora',
  'illustriousxl_style_lora',
  'krea2_concept_lora',
  'krea2_lora_16gb',
  'krea2_lora_low_vram',
  'sdxl_character_lora',
  'sdxl_concept_lora',
  'sdxl_style_lora',
  'zimage_character_lora',
  'zimage_concept_lora',
  'zimage_style_lora',
]);

export const isBuiltinPreset = (name: string): boolean => BUILTIN_PRESET_NAMES.has(name);

export const getPresetsRoot = async () => {
  const key = 'PRESETS_FOLDER';
  let presetsPath = myCache.get(key) as string;
  if (!presetsPath) {
    const row = await prisma.settings.findFirst({
      where: {
        key: key,
      },
    });
    presetsPath = defaultPresetsFolder;
    if (row?.value && row.value !== '') {
      presetsPath = row.value;
    }
    myCache.set(key, presetsPath);
  }
  if (!fs.existsSync(presetsPath)) {
    fs.mkdirSync(presetsPath, { recursive: true });
  }
  return presetsPath;
};

// Presets are addressed by their file basename without extension. Only allow simple
// names so a request can never escape the presets folder.
export const sanitizePresetName = (name: string): string => {
  return path
    .basename(name)
    .replace(/\.(json|jsonc|yaml|yml)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_');
};

// Find the file for a preset name, trying each supported extension. Tries the exact
// basename first so drop-in files with uppercase/spaces still resolve, then the sanitized
// form used for UI-saved presets. basename() prevents path traversal in both cases.
export const findPresetFile = async (name: string): Promise<string | null> => {
  const presetsRoot = await getPresetsRoot();
  const exactName = path.basename(name).replace(/\.(json|jsonc|yaml|yml)$/i, '');
  const candidates = [exactName, sanitizePresetName(name)];
  for (const candidate of candidates) {
    if (candidate === '') continue;
    for (const ext of presetExtensions) {
      const filePath = path.join(presetsRoot, `${candidate}${ext}`);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }
  }
  return null;
};
