import { NextResponse } from 'next/server';
import fs from 'fs';
import { getDatasetsRoot } from '@/server/settings';
import { resolveDatasetPath, sanitizeDatasetName } from '@/server/datasetFiles';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const requestedName = sanitizeDatasetName(body?.name);
    if (!requestedName) {
      return NextResponse.json({ error: 'Invalid dataset name' }, { status: 400 });
    }

    // clean name by making lower case,  removing special characters, and replacing spaces with underscores
    const name = requestedName.toLowerCase().replace(/[^a-z0-9]+/g, '_');

    const datasetsPath = await getDatasetsRoot();
    const datasetPath = resolveDatasetPath(datasetsPath, name);
    if (!datasetPath) {
      return NextResponse.json({ error: 'Invalid dataset name' }, { status: 400 });
    }

    // if folder doesnt exist, create it
    if (!fs.existsSync(datasetPath)) {
      fs.mkdirSync(datasetPath);
    }

    return NextResponse.json({ success: true, name: name });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to create dataset' }, { status: 500 });
  }
}
