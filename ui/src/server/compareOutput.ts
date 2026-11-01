// Fork-only (see FORK_NOTES.md). Where Checkpoint Compare writes renders. A Settings row, not
// a schema change, and not part of /api/settings, whose POST only touches its own four keys.
import path from 'path';
import prisma from '@/server/prisma';
import { getDataRoot } from '@/server/settings';

const KEY = 'COMPARE_OUTPUT_FOLDER';

export const getCompareOutputFolder = async () => {
  const row = await prisma.settings.findFirst({ where: { key: KEY } });
  return row?.value || path.join(await getDataRoot(), 'compare');
};

export const setCompareOutputFolder = (value: string) =>
  prisma.settings.upsert({ where: { key: KEY }, update: { value }, create: { key: KEY, value } });
