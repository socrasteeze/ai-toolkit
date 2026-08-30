import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { BUILTIN_PRESET_NAMES } from '../src/server/builtinPresets.ts';

// The set that flags built-ins in the Presets dialog used to be hand-synced with the files
// in presets/ and drifted five presets behind (2026-08-29). This pins it to the directory.
const presetsDir = path.resolve(import.meta.dirname, '..', '..', 'presets');
const shipped = readdirSync(presetsDir)
  .filter(name => /\.(json|jsonc|yaml|yml)$/i.test(name))
  .map(name => name.replace(/\.(json|jsonc|yaml|yml)$/i, ''))
  .sort();

test('BUILTIN_PRESET_NAMES lists exactly the presets shipped in presets/', () => {
  assert.deepEqual([...BUILTIN_PRESET_NAMES].sort(), shipped);
});

test('every shipped preset name is already in sanitized form', () => {
  for (const name of shipped) {
    assert.match(name, /^[a-z0-9._-]+$/, `${name} would be rewritten by sanitizePresetName`);
  }
});
