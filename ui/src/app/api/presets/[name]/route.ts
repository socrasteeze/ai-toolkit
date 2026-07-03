import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import YAML from 'yaml';
import { findPresetFile } from '@/server/presetsPath';

// Fork-only route (see FORK_NOTES.md). Reads or deletes a single preset file.
// YAML parsing happens server-side so the client always receives a plain config object,
// whether the file is a UI JSON export or a CLI-style YAML from config/examples.

export async function GET(request: NextRequest, { params }: { params: { name: string } }) {
  const { name } = await params;
  try {
    const filePath = await findPresetFile(name);
    if (!filePath) {
      return NextResponse.json({ error: `Preset '${name}' not found` }, { status: 404 });
    }
    const text = await fs.promises.readFile(filePath, 'utf-8');
    let config: any;
    if (filePath.endsWith('.json') || filePath.endsWith('.jsonc')) {
      config = JSON.parse(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
    } else {
      config = YAML.parse(text);
    }
    return NextResponse.json({ name, config });
  } catch (error) {
    console.error('Error reading preset:', error);
    return NextResponse.json({ error: 'Failed to read preset' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { name: string } }) {
  const { name } = await params;
  try {
    const filePath = await findPresetFile(name);
    if (!filePath) {
      return NextResponse.json({ error: `Preset '${name}' not found` }, { status: 404 });
    }
    await fs.promises.unlink(filePath);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting preset:', error);
    return NextResponse.json({ error: 'Failed to delete preset' }, { status: 500 });
  }
}
