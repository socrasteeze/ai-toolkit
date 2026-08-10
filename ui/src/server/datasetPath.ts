import path from 'path';

/**
 * Validates one top-level dataset directory name.
 *
 * A dataset name is a single path component, never a relative or absolute path.
 * Keep the original spelling so existing datasets with spaces continue to work.
 */
export const sanitizeDatasetName = (name: unknown): string | null => {
  if (typeof name !== 'string' || name.trim() === '') return null;
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return null;
  return name;
};

/**
 * Resolves a validated dataset name below the configured datasets root.
 *
 * The containment check is intentionally retained after component validation so
 * future changes to the accepted name format cannot accidentally reintroduce a
 * traversal in destructive callers.
 */
export const resolveDatasetPath = (datasetsRoot: string, name: unknown): string | null => {
  const safeName = sanitizeDatasetName(name);
  if (!safeName) return null;

  const resolvedRoot = path.resolve(datasetsRoot);
  const resolvedDataset = path.resolve(resolvedRoot, safeName);
  const relative = path.relative(resolvedRoot, resolvedDataset);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return resolvedDataset;
};

/** Find two names that would address the same file on a case-insensitive host. */
export const findCaseInsensitiveNameCollision = (names: string[]): [string, string] | null => {
  const seen = new Map<string, string>();
  for (const name of names) {
    const key = name.toLowerCase();
    const existing = seen.get(key);
    if (existing !== undefined) return [existing, name];
    seen.set(key, name);
  }
  return null;
};
