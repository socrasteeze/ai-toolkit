import fs from 'fs';
import path from 'path';

export interface DatasetScopeOptions {
  includeLooseFiles?: boolean;
  includeSubfolders?: string[] | null;
}

export const parseDatasetScope = (
  includeLooseFiles: unknown,
  includeSubfolders: unknown,
): Required<DatasetScopeOptions> | null => {
  if (includeLooseFiles !== undefined && typeof includeLooseFiles !== 'boolean') return null;
  if (includeSubfolders !== undefined && includeSubfolders !== null && !Array.isArray(includeSubfolders)) return null;

  const normalized: string[] | null = includeSubfolders == null ? null : [];
  if (Array.isArray(includeSubfolders)) {
    const seen = new Set<string>();
    for (const name of includeSubfolders) {
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        name === '.' ||
        name === '..' ||
        name.includes('/') ||
        name.includes('\\')
      ) {
        return null;
      }
      if (!seen.has(name)) {
        seen.add(name);
        normalized?.push(name);
      }
    }
  }

  return {
    includeLooseFiles: includeLooseFiles !== false,
    includeSubfolders: normalized,
  };
};

export const listScopedDatasetFiles = async (
  dir: string,
  acceptsFile: (name: string) => boolean,
  scope: DatasetScopeOptions = {},
): Promise<string[]> => {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const selectedSubfolders = scope.includeSubfolders == null ? null : new Set(scope.includeSubfolders);
  const includeLooseFiles = scope.includeLooseFiles !== false;
  const files: string[] = [];
  const subdirs: string[] = [];

  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (name === '_controls') continue;
      if (selectedSubfolders !== null && !selectedSubfolders.has(name)) continue;
      subdirs.push(path.join(dir, name));
    } else if (entry.isFile() && includeLooseFiles && acceptsFile(name)) {
      files.push(path.join(dir, name));
    }
  }

  const nested = await Promise.all(subdirs.map(subdir => listScopedDatasetFiles(subdir, acceptsFile)));
  return files.concat(...nested);
};
