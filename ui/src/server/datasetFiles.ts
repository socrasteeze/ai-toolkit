import fs from 'fs';
import path from 'path';

// Fork-only file (see FORK_NOTES.md). Counts trainable media files in a dataset folder.
// The extension whitelist and exclusions mirror both the UI's listImages route
// (ui/src/app/api/datasets/listImages/route.ts) and the trainer's own enumeration
// (toolkit/data_loader.py skips the _controls folder) — keep them in sync.

import { getImageDimensions } from './imageSize';
import { DatasetScopeOptions, listScopedDatasetFiles } from './datasetScope';

export { parseDatasetScope } from './datasetScope';

// Kept re-exported from this established module so existing route imports remain stable.
export { findCaseInsensitiveNameCollision, resolveDatasetPath, sanitizeDatasetName } from './datasetPath';

const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.m4v', '.flv'];
const audioExtensions = ['.mp3', '.wav', '.flac', '.ogg'];

// Resolves an optional "/"-joined subPath (from the folder-browser modal — see
// browse/route.ts) onto a dataset root, for routes that need to scope an operation
// (count, analyze, browse) to a nested folder within a dataset instead of the whole
// thing. Segments are filtered before joining so ".." components can never survive into
// the resolved path, then belt-and-suspenders confirmed to still resolve inside
// datasetRoot. Returns the resolved absolute path, or null if subPath is invalid.
export const resolveDatasetSubPath = (datasetRoot: string, subPath?: string): string | null => {
  const segments: string[] =
    typeof subPath === 'string' && subPath.length > 0
      ? subPath.split('/').filter(seg => seg && seg !== '.' && seg !== '..')
      : [];
  const target = path.join(datasetRoot, ...segments);
  const resolvedRoot = path.resolve(datasetRoot);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return target;
};

export interface DatasetFileCounts {
  imageCount: number;
  videoCount: number;
  audioCount: number;
  totalCount: number;
}

export const countDatasetFiles = async (dir: string, scope: DatasetScopeOptions = {}): Promise<DatasetFileCounts> => {
  const counts: DatasetFileCounts = { imageCount: 0, videoCount: 0, audioCount: 0, totalCount: 0 };
  const files = await listScopedDatasetFiles(
    dir,
    name => {
      const ext = path.extname(name).toLowerCase();
      return imageExtensions.includes(ext) || videoExtensions.includes(ext) || audioExtensions.includes(ext);
    },
    scope,
  );
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (imageExtensions.includes(ext)) counts.imageCount++;
    else if (videoExtensions.includes(ext)) counts.videoCount++;
    else if (audioExtensions.includes(ext)) counts.audioCount++;
  }
  counts.totalCount = counts.imageCount + counts.videoCount + counts.audioCount;
  return counts;
};

export interface DatasetImageAnalysis {
  imageCount: number;
  // "WxH" -> number of images at that exact source size
  dimensionCounts: Record<string, number>;
  // images with no caption file of any of the caption extensions next to them
  missingCaptions: number;
  // images whose header could not be parsed for dimensions
  unreadable: number;
}

// caption files the trainer accepts sit next to the image with the same stem
const captionExtensions = ['.txt', '.json', '.caption'];

const listImageFiles = async (dir: string, scope: DatasetScopeOptions = {}): Promise<string[]> => {
  return listScopedDatasetFiles(dir, name => imageExtensions.includes(path.extname(name).toLowerCase()), scope);
};

export const analyzeDatasetImages = async (
  dir: string,
  scope: DatasetScopeOptions = {},
): Promise<DatasetImageAnalysis> => {
  const files = await listImageFiles(dir, scope);
  const analysis: DatasetImageAnalysis = {
    imageCount: files.length,
    dimensionCounts: {},
    missingCaptions: 0,
    unreadable: 0,
  };

  // bounded concurrency — datasets can hold thousands of images
  const CONCURRENCY = 16;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const stem = file.slice(0, file.length - path.extname(file).length);
      const [dims, captions] = await Promise.all([
        getImageDimensions(file),
        Promise.all(
          captionExtensions.map(ext =>
            fs.promises.access(stem + ext).then(
              () => true,
              () => false,
            ),
          ),
        ),
      ]);
      if (dims) {
        const key = `${dims.width}x${dims.height}`;
        analysis.dimensionCounts[key] = (analysis.dimensionCounts[key] || 0) + 1;
      } else {
        analysis.unreadable++;
      }
      if (!captions.some(Boolean)) analysis.missingCaptions++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

  return analysis;
};
