import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import YAML from 'yaml';
import path from 'path';
import { findPresetFile, getUserPresetsRoot, isBuiltinPreset } from '@/server/presetsPath';
import { parseJsonc } from '@/utils/jsonc';

// Fork-only route (see FORK_NOTES.md). Reads or deletes a single preset file.
// YAML parsing happens server-side so the client always receives a plain config object,
// whether the file is a UI JSON export or a CLI-style YAML from config/examples.

export async function GET(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  try {
    const filePath = await findPresetFile(name);
    if (!filePath) {
      return NextResponse.json({ error: `Preset '${name}' not found` }, { status: 404 });
    }
    const text = await fs.promises.readFile(filePath, 'utf-8');
    let config: any;
    if (filePath.endsWith('.json') || filePath.endsWith('.jsonc')) {
      // string-aware: a `//` inside "https://..." must not truncate the line
      config = parseJsonc(text);
    } else {
      config = YAML.parse(text);
    }
    return NextResponse.json({ name, config });
  } catch (error) {
    console.error('Error reading preset:', error);
    return NextResponse.json({ error: 'Failed to read preset' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  try {
    const filePath = await findPresetFile(name);
    if (!filePath) {
      return NextResponse.json({ error: `Preset '${name}' not found` }, { status: 404 });
    }
    // a shipped built-in is tracked in git; deleting it would dirty the tree and block a rebuild
    const isUserCopy = path.dirname(filePath) === (await getUserPresetsRoot());
    if (!isUserCopy && isBuiltinPreset(path.basename(filePath, path.extname(filePath)))) {
      return NextResponse.json(
        { error: `'${name}' is a built-in preset shipped with the fork and can't be deleted from the UI` },
        { status: 400 },
      );
    }
    await fs.promises.unlink(filePath);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting preset:', error);
    return NextResponse.json({ error: 'Failed to delete preset' }, { status: 500 });
  }
}
