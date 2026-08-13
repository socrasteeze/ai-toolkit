import { NextResponse } from 'next/server';
import fs from 'fs';
import { getDatasetsRoot } from '@/server/settings';
import {
  analyzeDatasetImages,
  parseDatasetScope,
  resolveDatasetPath,
  resolveDatasetSubPath,
} from '@/server/datasetFiles';

// Fork-only route (see FORK_NOTES.md). Dimension/caption scan for a dataset (or a
// subfolder within it, via optional subPath — see PLAN.md's dataset-folder-browser
// entry) — feeds the dataset analyzer in the new-job form. Pure I/O: bucketing and
// advice are computed client-side so they react to batch/resolution changes without
// re-scanning.

export async function POST(request: Request) {
  const datasetsPath = await getDatasetsRoot();
  const body = await request.json();
  const { datasetName, subPath, includeLooseFiles, includeSubfolders } = body;
  if (!datasetName || typeof datasetName !== 'string') {
    return NextResponse.json({ error: 'datasetName is required' }, { status: 400 });
  }
  // datasetName is a folder name under the datasets root; never allow traversal
  const datasetRoot = resolveDatasetPath(datasetsPath, datasetName);
  if (!datasetRoot) {
    return NextResponse.json({ error: 'Invalid datasetName' }, { status: 400 });
  }
  const datasetFolder = resolveDatasetSubPath(datasetRoot, subPath);
  if (!datasetFolder) {
    return NextResponse.json({ error: 'Invalid subPath' }, { status: 400 });
  }
  const scope = parseDatasetScope(includeLooseFiles, includeSubfolders);
  if (!scope) {
    return NextResponse.json({ error: 'Invalid dataset scope' }, { status: 400 });
  }

  try {
    try {
      await fs.promises.access(datasetFolder);
    } catch {
      return NextResponse.json({ error: `Folder '${datasetName}' not found` }, { status: 404 });
    }

    const analysis = await analyzeDatasetImages(datasetFolder, scope);
    return NextResponse.json(analysis);
  } catch (error) {
    console.error('Error analyzing dataset:', error);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
}
