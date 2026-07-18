import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getDatasetsRoot } from '@/server/settings';
import { analyzeDatasetImages, sanitizeDatasetName } from '@/server/datasetFiles';

// Fork-only route (see FORK_NOTES.md). Dimension/caption scan for a dataset — feeds the
// dataset analyzer in the new-job form. Pure I/O: bucketing and advice are computed
// client-side so they react to batch/resolution changes without re-scanning.

export async function POST(request: Request) {
  const datasetsPath = await getDatasetsRoot();
  const body = await request.json();
  const { datasetName } = body;
  if (!datasetName || typeof datasetName !== 'string') {
    return NextResponse.json({ error: 'datasetName is required' }, { status: 400 });
  }
  // datasetName is a folder name under the datasets root; never allow traversal
  const safeDatasetName = sanitizeDatasetName(datasetName);
  if (!safeDatasetName) {
    return NextResponse.json({ error: 'Invalid datasetName' }, { status: 400 });
  }
  const datasetFolder = path.join(datasetsPath, safeDatasetName);

  try {
    try {
      await fs.promises.access(datasetFolder);
    } catch {
      return NextResponse.json({ error: `Folder '${datasetName}' not found` }, { status: 404 });
    }

    const analysis = await analyzeDatasetImages(datasetFolder);
    return NextResponse.json(analysis);
  } catch (error) {
    console.error('Error analyzing dataset:', error);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
}
