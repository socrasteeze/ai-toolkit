import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getDatasetsRoot } from '@/server/settings';
import { countDatasetFiles } from '@/server/datasetFiles';

// Fork-only route (see FORK_NOTES.md). Lightweight file count for a dataset — used by the
// step-count suggestion in the new-job form. Cheaper than listImages (no path list).

export async function POST(request: Request) {
  const datasetsPath = await getDatasetsRoot();
  const body = await request.json();
  const { datasetName } = body;
  if (!datasetName || typeof datasetName !== 'string') {
    return NextResponse.json({ error: 'datasetName is required' }, { status: 400 });
  }
  // datasetName is a folder name under the datasets root; never allow traversal
  const datasetFolder = path.join(datasetsPath, path.basename(datasetName));

  try {
    try {
      await fs.promises.access(datasetFolder);
    } catch {
      return NextResponse.json({ error: `Folder '${datasetName}' not found` }, { status: 404 });
    }

    const counts = await countDatasetFiles(datasetFolder);
    return NextResponse.json(counts);
  } catch (error) {
    console.error('Error counting dataset files:', error);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
}
