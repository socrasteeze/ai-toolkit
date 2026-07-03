import fs from 'fs';
import path from 'path';

// Fork-only file (see FORK_NOTES.md). Counts trainable media files in a dataset folder.
// The extension whitelist and exclusions mirror both the UI's listImages route
// (ui/src/app/api/datasets/listImages/route.ts) and the trainer's own enumeration
// (toolkit/data_loader.py skips the _controls folder) — keep them in sync.

const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.m4v', '.flv'];
const audioExtensions = ['.mp3', '.wav', '.flac', '.ogg'];

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
