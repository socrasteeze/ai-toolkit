import { NextResponse } from 'next/server';
import fs from 'fs';
import { getDatasetsRoot } from '@/server/settings';
import { resolveDatasetPath } from '@/server/datasetFiles';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const datasetsPath = await getDatasetsRoot();
    const datasetPath = resolveDatasetPath(datasetsPath, body?.name);
    if (!datasetPath) {
      return NextResponse.json({ error: 'Invalid dataset name' }, { status: 400 });
    }

    // if folder doesnt exist, ignore
    if (!fs.existsSync(datasetPath)) {
      return NextResponse.json({ success: true });
    }

    // delete it and return success
    fs.rmSync(datasetPath, { recursive: true, force: true });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to delete dataset' }, { status: 500 });
  }
}
