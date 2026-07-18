import fs from 'fs';
import path from 'path';

// Fork-only file (see FORK_NOTES.md). Counts trainable media files in a dataset folder.
// The extension whitelist and exclusions mirror both the UI's listImages route
// (ui/src/app/api/datasets/listImages/route.ts) and the trainer's own enumeration
// (toolkit/data_loader.py skips the _controls folder) — keep them in sync.

import { getImageDimensions } from './imageSize';

const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.m4v', '.flv'];
const audioExtensions = ['.mp3', '.wav', '.flac', '.ogg'];

// Validates a user-supplied top-level dataset folder name before it's joined onto the
// datasets root. path.basename() alone is NOT sufficient here: path.basename('..')
// returns '..' unchanged (it only strips leading directory components, it doesn't
// resolve relative segments), so a bare ".." or "." value passes through untouched and
// path.join(datasetsRoot, '..') escapes the datasets root entirely. Found via a live
// curl test against the new browse route (2026-07-19) — see PLAN.md. Returns the name
// unchanged if safe, or null if it isn't (caller should respond 400).
export const sanitizeDatasetName = (name: string): string | null => {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return null;
  return name;
};

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

export const countDatasetFiles = async (dir: string): Promise<DatasetFileCounts> => {
  const counts: DatasetFileCounts = { imageCount: 0, videoCount: 0, audioCount: 0, totalCount: 0 };
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  const subdirs: string[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (name === '_controls') continue;
      subdirs.push(path.join(dir, name));
    } else if (entry.isFile()) {
      const ext = path.extname(name).toLowerCase();
      if (imageExtensions.includes(ext)) counts.imageCount++;
      else if (videoExtensions.includes(ext)) counts.videoCount++;
      else if (audioExtensions.includes(ext)) counts.audioCount++;
    }
  }

  const nested = await Promise.all(subdirs.map(subdir => countDatasetFiles(subdir)));
  for (const sub of nested) {
    counts.imageCount += sub.imageCount;
    counts.videoCount += sub.videoCount;
    counts.audioCount += sub.audioCount;
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

const listImageFiles = async (dir: string): Promise<string[]> => {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  const subdirs: string[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (name === '_controls') continue;
      subdirs.push(path.join(dir, name));
    } else if (entry.isFile() && imageExtensions.includes(path.extname(name).toLowerCase())) {
      files.push(path.join(dir, name));
    }
  }
  const nested = await Promise.all(subdirs.map(listImageFiles));
  return files.concat(...nested);
};

export const analyzeDatasetImages = async (dir: string): Promise<DatasetImageAnalysis> => {
  const files = await listImageFiles(dir);
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
