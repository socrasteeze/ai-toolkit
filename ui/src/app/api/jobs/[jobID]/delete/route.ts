import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/server/prisma';

export async function GET(request: NextRequest, { params }: { params: Promise<{ jobID: string }> }) {
  const { jobID } = await params;

  const job = await prisma.job.findUnique({
    where: { id: jobID },
  });

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  // fork: delete the DB job only. The training folder stays on disk
  // (checkpoints, samples, logs, loss_log.db). Do not restore the folder rm.
  await prisma.job.delete({
    where: { id: jobID },
  });

  return NextResponse.json(job);
}
