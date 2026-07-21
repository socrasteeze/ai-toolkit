import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getPresetsRoot, presetExtensions, sanitizePresetName, isBuiltinPreset } from '@/server/presetsPath';

// Fork-only route (see FORK_NOTES.md). Presets are plain config files in the presets
// folder so other users' configs can be dropped in without touching the database.

export async function GET() {
  try {
    const presetsRoot = await getPresetsRoot();
    const entries = await fs.promises.readdir(presetsRoot, { withFileTypes: true });
    const presets = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!presetExtensions.includes(ext)) continue;
      const filePath = path.join(presetsRoot, entry.name);
      const stat = await fs.promises.stat(filePath);
      const name = entry.name.slice(0, -ext.length);
      presets.push({
        name,
        fileName: entry.name,
        updatedAt: stat.mtimeMs,
        builtIn: isBuiltinPreset(name),
      });
    }
    presets.sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ presets });
  } catch (error) {
    console.error('Error listing presets:', error);
    return NextResponse.json({ error: 'Failed to list presets' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, config } = body;
    if (!name || !config) {
      return NextResponse.json({ error: 'name and config are required' }, { status: 400 });
    }
    const safeName = sanitizePresetName(name);
    if (safeName === '') {
      return NextResponse.json({ error: 'Invalid preset name' }, { status: 400 });
    }
    const presetsRoot = await getPresetsRoot();
    const filePath = path.join(presetsRoot, `${safeName}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(config, null, 2));
    return NextResponse.json({ success: true, name: safeName });
  } catch (error) {
    console.error('Error saving preset:', error);
    return NextResponse.json({ error: 'Failed to save preset' }, { status: 500 });
  }
}
