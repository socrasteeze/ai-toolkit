import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getDatasetsRoot } from '@/server/settings';
import { sanitizeDatasetName, resolveDatasetSubPath } from '@/server/datasetFiles';

// Fork-only route (see FORK_NOTES.md). Lists the immediate subfolders of a dataset (or a
// subfolder within it), for the folder-browser modal that lets a job target a nested
// folder (e.g. "Dataset/Folder 1/Folder 1a") instead of only a top-level dataset — see
// PLAN.md's dataset-folder-browser entry. Non-recursive per call: each navigation step
// is one shallow readdir, kept fast regardless of how deep the tree goes.

interface BreadcrumbEntry {
  label: string;
  path: string; // subPath to pass back in to browse to this level, "" for the dataset root
}

interface FolderEntry {
  name: string;
  path: string; // subPath to pass back in to browse into this folder
}

export async function POST(request: Request) {
  const datasetsRoot = await getDatasetsRoot();
  const body = await request.json();
  const { datasetName, subPath } = body;
  if (!datasetName || typeof datasetName !== 'string') {
    return NextResponse.json({ error: 'datasetName is required' }, { status: 400 });
  }

  // datasetName is a folder name directly under the datasets root; never allow traversal
  const safeDatasetName = sanitizeDatasetName(datasetName);
  if (!safeDatasetName) {
    return NextResponse.json({ error: 'Invalid datasetName' }, { status: 400 });
  }
  const datasetRoot = path.join(datasetsRoot, safeDatasetName);

  // subPath is a "/"-joined chain of folder names below the dataset root; segments are
  // filtered the same way resolveDatasetSubPath filters them, so both agree on what's
  // safe. Kept separately here (rather than derived from the resolved path) to build
  // breadcrumbs/child paths without re-splitting an OS path back into "/"-joined form.
  const segments: string[] =
    typeof subPath === 'string' && subPath.length > 0
      ? subPath.split('/').filter(seg => seg && seg !== '.' && seg !== '..')
      : [];
  const targetDir = resolveDatasetSubPath(datasetRoot, subPath);
  if (!targetDir) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  try {
    try {
      await fs.promises.access(targetDir);
    } catch {
      return NextResponse.json({ error: `Folder not found` }, { status: 404 });
    }

    const dirents = await fs.promises.readdir(targetDir, { withFileTypes: true });
    const folders: FolderEntry[] = dirents
      .filter(dirent => dirent.isDirectory())
      .filter(dirent => !dirent.name.startsWith('.') && dirent.name !== '_controls')
      .map(dirent => ({
        name: dirent.name,
        path: segments.length > 0 ? `${segments.join('/')}/${dirent.name}` : dirent.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const breadcrumbs: BreadcrumbEntry[] = [{ label: datasetName, path: '' }];
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      breadcrumbs.push({ label: seg, path: acc });
    }

    return NextResponse.json({ breadcrumbs, folders });
  } catch (error) {
    console.error('Error browsing dataset folder:', error);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
}
