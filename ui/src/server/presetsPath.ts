import fs from 'fs';
import path from 'path';
import NodeCache from 'node-cache';
import { TOOLKIT_ROOT } from '@/paths';
import prisma from '@/server/prisma';

// Fork-only file (see FORK_NOTES.md). Mirrors the getDatasetsRoot() pattern in
// ./settings.ts, but kept separate so upstream changes to settings.ts never conflict.
// Short TTL so a PRESETS_FOLDER settings change is picked up without a restart.
const myCache = new NodeCache({ stdTTL: 60 });

export const defaultPresetsFolder = path.join(TOOLKIT_ROOT, 'presets');

export const presetExtensions = ['.json', '.jsonc', '.yaml', '.yml'];

// The shipped-preset set lives in ./builtinPresets.ts (dependency-free so the contract
// test can pin it to the files in presets/); re-exported here so route imports stay stable.
export { BUILTIN_PRESET_NAMES, isBuiltinPreset } from './builtinPresets';

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

// UI saves land here (git-ignored by presets/.gitignore), never over a shipped file, so saving,
// overwriting or deleting a preset from the UI can't dirty the git tree. A copy here with a
// built-in's name shadows it; deleting the copy restores the shipped version.
export const getUserPresetsRoot = async () => {
  const userRoot = path.join(await getPresetsRoot(), 'user');
  if (!fs.existsSync(userRoot)) {
    fs.mkdirSync(userRoot, { recursive: true });
  }
  return userRoot;
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
// The user folder is searched first so a user copy shadows a shipped preset of the same name.
export const findPresetFile = async (name: string): Promise<string | null> => {
  const roots = [await getUserPresetsRoot(), await getPresetsRoot()];
  const exactName = path.basename(name).replace(/\.(json|jsonc|yaml|yml)$/i, '');
  const candidates = [exactName, sanitizePresetName(name)];
  for (const root of roots) {
    for (const candidate of candidates) {
      if (candidate === '') continue;
      for (const ext of presetExtensions) {
        const filePath = path.join(root, `${candidate}${ext}`);
        if (fs.existsSync(filePath)) {
          return filePath;
        }
      }
    }
  }
  return null;
};
