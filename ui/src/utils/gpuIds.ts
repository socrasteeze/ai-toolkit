/**
 * Remote-GPU identity. Browser / Next side.
 *
 * Mirror of `cron/gpuIds.ts` -- read that file for why `gpu_ids` carries the
 * machine name and why nothing else had to change. The worker build
 * (`tsconfig.worker.json`) includes only `cron/**` and cannot import from
 * `src/`, which is the same forced split that already exists between
 * `cron/paths.ts` and `src/server/settings.ts`. Keep the two copies in step.
 */

/** Separator between the peer id and the peer-local GPU list. */
export const PEER_GPU_SEPARATOR = ':';

/** Peer ids are restricted to this shape so they can never contain the separator. */
export const PEER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * True if this `gpu_ids` value names another machine.
 *
 * "mps" carries no separator, so it falls out as local without a special case.
 */
export function isRemoteGpu(gpuIds: string | null | undefined): boolean {
  if (!gpuIds) {
    return false;
  }
  return gpuIds.includes(PEER_GPU_SEPARATOR);
}

/** Splits a tagged `gpu_ids` into the peer id and the GPU list as that peer knows it. */
export function splitPeerGpu(gpuIds: string | null | undefined): { peerId: string; localGpuIds: string } | null {
  if (!isRemoteGpu(gpuIds)) {
    return null;
  }
  const raw = gpuIds as string;
  const at = raw.indexOf(PEER_GPU_SEPARATOR);
  const peerId = raw.slice(0, at).trim();
  const localGpuIds = raw.slice(at + 1).trim();
  if (peerId === '' || localGpuIds === '') {
    return null;
  }
  return { peerId, localGpuIds };
}

/** Builds the tagged form. */
export function makeRemoteGpuId(peerId: string, localGpuIds: string): string {
  return `${peerId}${PEER_GPU_SEPARATOR}${localGpuIds}`;
}

/**
 * The numeric CUDA indices in a `gpu_ids` value, for looking up live stats.
 *
 * Upstream call sites do `gpu_ids.split(',').map(id => parseInt(id))`, which
 * yields `[NaN]` for a remote value and silently matches no GPU. This returns
 * an empty list for a remote or Mac value instead, so a caller can tell
 * "no local GPUs to show" from "GPU 0".
 */
export function parseLocalGpuIndices(gpuIds: string | null | undefined): number[] {
  if (!gpuIds || gpuIds === 'mps' || isRemoteGpu(gpuIds)) {
    return [];
  }
  return gpuIds
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(id => !Number.isNaN(id));
}
