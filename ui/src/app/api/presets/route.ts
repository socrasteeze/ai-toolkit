import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import {
  getPresetsRoot,
  getUserPresetsRoot,
  presetExtensions,
  sanitizePresetName,
  isBuiltinPreset,
  findPresetFile,
} from '@/server/presetsPath';

// Fork-only route (see FORK_NOTES.md). Presets are plain config files in the presets
// folder so other users' configs can be dropped in without touching the database.

export async function GET() {
  try {
    // user folder first: a user copy shadows the shipped preset of the same name
    const userRoot = await getUserPresetsRoot();
    const presets = [];
    const seen = new Set<string>();
    for (const root of [userRoot, await getPresetsRoot()]) {
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!presetExtensions.includes(ext)) continue;
        const name = entry.name.slice(0, -ext.length);
        if (seen.has(name)) continue;
        seen.add(name);
        const stat = await fs.promises.stat(path.join(root, entry.name));
        presets.push({
          name,
          fileName: entry.name,
          updatedAt: stat.mtimeMs,
          builtIn: isBuiltinPreset(name),
          modified: root === userRoot && isBuiltinPreset(name),
        });
      }
    }
    presets.sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ presets });
  } catch (error) {
    console.error('Error listing presets:', error);
    return NextResponse.json({ error: 'Failed to list presets' }, { status: 500 });
  }
}

// POST { name, config, overwrite? }. Writing over an existing preset requires
// `overwrite: true` — the Presets dialog's explicit Overwrite button sends it, "Save as
// new" does not, so a typo that matches an existing name (or a shipped, provenance-tracked
// built-in) gets a 409 instead of a silent replacement. The guard used to be client-only.
export async function POST(request: Request) {
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
    }
    const { name, config, overwrite } = body ?? {};
    if (!name || !config) {
      return NextResponse.json({ error: 'name and config are required' }, { status: 400 });
    }
    const safeName = sanitizePresetName(name);
    if (safeName === '') {
      return NextResponse.json({ error: 'Invalid preset name' }, { status: 400 });
    }
    // always written to the user folder; overwriting a built-in leaves the shipped file untouched
    const filePath = path.join(await getUserPresetsRoot(), `${safeName}.json`);
    if (overwrite !== true) {
      if (isBuiltinPreset(safeName) || (await findPresetFile(safeName))) {
        const what = isBuiltinPreset(safeName) ? 'a built-in preset shipped with the fork' : 'an existing preset';
        return NextResponse.json(
          { error: `'${safeName}' is ${what} — use Overwrite to replace it, or pick another name` },
          { status: 409 },
        );
      }
    }
    await fs.promises.writeFile(filePath, JSON.stringify(config, null, 2));
    return NextResponse.json({ success: true, name: safeName });
  } catch (error) {
    console.error('Error saving preset:', error);
    return NextResponse.json({ error: 'Failed to save preset' }, { status: 500 });
  }
}
