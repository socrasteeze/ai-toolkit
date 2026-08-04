/**
 * Remote-GPU identity. Worker side.
 *
 * A job's `gpu_ids` is an opaque string. Upstream puts a comma-joined CUDA
 * index list in it ("0", "0,1"), or the literal "mps" on a Mac. The fork
 * extends the same field to also name a machine: "<peerId>:<localIndex>".
 *
 * Nothing else had to change for that to work, and that is the whole reason
 * this encoding was chosen over a schema change (which fork rule 2 forbids):
 *
 *   - `Queue.gpu_ids` is `String @unique` and `Job.gpu_ids` is a plain String.
 *   - `processQueue` groups jobs by an EXACT string match on that column.
 *
 * So "workshop:0" becomes its own queue, with its own one-job-at-a-time
 * concurrency, without a single edit to `processQueue.ts`. A remote GPU can
 * never collide with local "0" because the strings differ.
 *
 * The peer is sent the LOCAL half ("0"), never the tagged form -- it is an
 * ordinary ai-toolkit instance and knows nothing about this encoding.
 *
 * Mirrored in `src/utils/gpuIds.ts` for the browser/Next side. The worker
 * build (`tsconfig.worker.json`) includes only `cron/**`, so it cannot import
 * from `src/`; the same forced split already exists between `cron/paths.ts`
 * and `src/server/settings.ts`. Keep the two copies in step.
 */

/** Separator between the peer id and the peer-local GPU list. */
export const PEER_GPU_SEPARATOR = ':';

/** Peer ids are restricted to this shape so they can never contain the separator. */
export const PEER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * True if this `gpu_ids` value names another machine.
 *
 * "mps" is deliberately not special-cased: it carries no separator, so it
 * falls out as local on its own.
 */
export function isRemoteGpu(gpuIds: string | null | undefined): boolean {
  if (!gpuIds) {
    return false;
  }
  return gpuIds.includes(PEER_GPU_SEPARATOR);
}

/**
 * Splits a tagged `gpu_ids` into the peer id and the GPU list as that peer
 * knows it. Returns null for a local value.
 *
 * Splits on the FIRST separator only, so a multi-GPU remote value
 * ("workshop:0,1") keeps its whole index list intact.
 */
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
