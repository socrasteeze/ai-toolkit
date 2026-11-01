import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getTrainingFolder } from '@/server/settings';
import { COMPARE_ROOT, isForbiddenPath, isUnder, readRunInfo, resolveReference, resolveRunFolder } from '@/server/compare';

// Fork-only (see FORK_NOTES.md). Public in middleware.ts like /api/img, because <img> cannot
// send the bearer token. Serves only cached renders and images in a run's own dataset.
export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const locate = async (q: URLSearchParams): Promise<string | null> => {
  const file = q.get('file');
  if (file) {
    const full = path.resolve(COMPARE_ROOT, file);
    return isUnder(full, COMPARE_ROOT) && !isForbiddenPath(full) && full.endsWith('.png') ? full : null;
  }
  const run = q.get('run');
  const reference = q.get('reference');
  if (!run || !reference) return null;
  const trainingRoot = await getTrainingFolder();
  const full = resolveReference(readRunInfo(resolveRunFolder(run, trainingRoot), trainingRoot), reference);
  if (!q.has('thumb')) return full;
  // the same pre-generated thumbs /api/img serves
  const thumb = path.join(path.dirname(full), '.thumbs', path.basename(full));
  return [`${thumb}.png`, `${thumb}.jpg`].find(p => fs.existsSync(p)) ?? full;
};

export async function GET(request: NextRequest) {
  try {
    const full = await locate(request.nextUrl.searchParams);
    if (!full || !fs.existsSync(full)) return new NextResponse('Not found', { status: 404 });
    const bytes = await fs.promises.readFile(full);
    return new NextResponse(bytes, {
      headers: {
        'Content-Type': TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
