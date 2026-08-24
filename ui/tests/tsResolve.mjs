// Fork-only test helper (see FORK_NOTES.md).
//
// `npm test` runs the contract suites on bare Node via --experimental-strip-types, with no
// bundler and no npm dependencies. Node's ESM resolver requires a file extension, but the
// app's own source uses Next/webpack-style extensionless relative imports
// (e.g. stepSuggestion.ts does `import { getBucketForImageSize } from './buckets'`).
// Without this hook only leaf modules with zero relative imports are testable, which is why
// the suites used to reach advisorBatch.ts but not stepSuggestion.ts.
//
// This resolves a failed relative specifier by retrying it with the extensions Next would
// have tried. It changes nothing about how the app builds or runs — it exists solely so the
// test runner can follow the same import graph the bundler does.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CANDIDATE_SUFFIXES = ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.startsWith('.') || !context.parentURL) throw error;
    const basePath = fileURLToPath(new URL(specifier, context.parentURL));
    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = `${basePath}${suffix}`;
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
    throw error;
  }
}
