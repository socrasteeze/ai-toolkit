import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

/** Stable peer folder identity: readable job prefix plus a hash of the real DB id. */
export function stagedDatasetName(jobName: string, jobId: string, index: number): string {
  if (!jobId) {
    throw new Error('A remote staging dataset requires a stable job id.');
  }
  const safeName = jobName.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 80) || 'job';
  const identity = createHash('sha256').update(jobId).digest('hex').slice(0, 24);
  return `hub_${safeName}_${identity}_${index}`;
}

/**
 * Apply the peer upload route's sanitizer and reject names that would alias.
 *
 * Two names that sanitize to the same string alias on every filesystem, so that
 * is always fatal. Names that differ only in case alias only on a
 * case-insensitive peer — and a Linux hub sending a Linux peer `IMG.JPG` next to
 * `img.jpg` is a perfectly good dataset that staged fine for years. Since the
 * hub cannot see the peer's filesystem, it assumes the destructive case unless
 * the peer is marked `caseSensitiveFs`.
 */
export function sanitizePeerFilenames(
  originalNames: string[],
  options: { rejectCaseCollisions?: boolean } = {},
): string[] {
  const rejectCaseCollisions = options.rejectCaseCollisions ?? true;
  const exact = new Map<string, string>();
  const caseInsensitive = new Map<string, string>();

  return originalNames.map(originalName => {
    const peerName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');

    const sameName = exact.get(peerName);
    if (sameName !== undefined) {
      throw new Error(
        `Dataset files "${sameName}" and "${originalName}" collide on the peer after filename sanitization ` +
          `(both become "${peerName}"). Rename one before running remotely.`,
      );
    }
    exact.set(peerName, originalName);

    if (rejectCaseCollisions) {
      const sameLetters = caseInsensitive.get(peerName.toLowerCase());
      if (sameLetters !== undefined) {
        throw new Error(
          `Dataset files "${sameLetters}" and "${originalName}" differ only in capitalization ("${peerName}"), ` +
            `and would overwrite each other on a peer with a case-insensitive filesystem. Rename one, or set ` +
            `"caseSensitiveFs": true on this peer if its filesystem tells them apart.`,
        );
      }
      caseInsensitive.set(peerName.toLowerCase(), originalName);
    }
    return peerName;
  });
}

/** Entries the peer still has but the local dataset no longer contains. */
export function removedManifestFiles(
  previous: Record<string, string>,
  current: Record<string, string>,
): string[] {
  return Object.keys(previous).filter(name => !Object.prototype.hasOwnProperty.call(current, name));
}

export type ManifestResetReason =
  | { kind: 'untrusted' }
  | { kind: 'removed'; removed: string[] };

/**
 * What the peer told us about its staging manifest.
 *
 * `unavailable` is the important one: it means we never got an answer (timeout,
 * dropped connection, peer restarting), which says nothing at all about what is
 * staged there. Collapsing it into `untrusted` lets a momentary network blip
 * delete a multi-gigabyte staged dataset and re-send it.
 */
export type RemoteManifestState =
  | { kind: 'ok'; manifest: Record<string, string> }
  | { kind: 'untrusted' }
  | { kind: 'unavailable' };

/** Reset an unverifiable or stale staging folder before trusting its contents. */
export async function reconcileRemoteManifest(
  state: RemoteManifestState,
  current: Record<string, string>,
  reset: (reason: ManifestResetReason) => Promise<void>,
): Promise<Record<string, string>> {
  // Could not ask: re-send every file, but leave the folder alone. Uploads
  // overwrite by name, so a full re-send is already self-correcting for anything
  // stale, and deleting first would be destructive on no evidence.
  if (state.kind === 'unavailable') {
    return {};
  }

  if (state.kind === 'untrusted') {
    await reset({ kind: 'untrusted' });
    return {};
  }

  const removed = removedManifestFiles(state.manifest, current);
  if (removed.length > 0) {
    await reset({ kind: 'removed', removed });
    return {};
  }
  return state.manifest;
}

export type StopAcknowledgement =
  | { acknowledged: true }
  | { acknowledged: false; error: unknown };

/** A failed stop remains retryable until the peer actually acknowledges it. */
export async function attemptStopAcknowledgement(
  alreadyAcknowledged: boolean,
  send: () => Promise<unknown>,
): Promise<StopAcknowledgement> {
  if (alreadyAcknowledged) return { acknowledged: true };
  try {
    await send();
    return { acknowledged: true };
  } catch (error) {
    return { acknowledged: false, error };
  }
}

/** A peer-reported size is only worth comparing against when it is a real byte count. */
function isComparableSize(reported: unknown): reported is number {
  return typeof reported === 'number' && Number.isSafeInteger(reported) && reported >= 0;
}

/** Check a download against peer-reported size when that size is trustworthy. */
export function assertDownloadedSize(name: string, downloaded: number, reported: unknown): void {
  if (isComparableSize(reported) && downloaded !== reported) {
    throw new Error(`Downloaded ${name} is ${downloaded} bytes; the peer reported ${reported} bytes.`);
  }
}

/**
 * Whether a checkpoint we already hold locally makes the peer download pointless.
 *
 * `existingSize` is null when there is no local file (or it is not a regular
 * file). When the peer reports a usable size we insist on an exact match, so a
 * truncated earlier copy is replaced rather than trusted; when it reports
 * nothing comparable we fall back to "the file is there, keep it", which is the
 * behavior every re-queued job relied on before size reporting existed.
 */
export function shouldSkipExistingDownload(existingSize: number | null, reported: unknown): boolean {
  if (existingSize === null) return false;
  if (!isComparableSize(reported)) return true;
  return existingSize === reported;
}

export class TemporaryFileCleanupError extends Error {
  readonly failures: unknown[];

  constructor(failures: unknown[]) {
    super(`Could not remove ${failures.length} remote-checkpoint temporary file${failures.length === 1 ? '' : 's'}.`);
    this.name = 'TemporaryFileCleanupError';
    this.failures = failures;
  }
}

type DownloadAndReplaceOptions = {
  remove?: (temporaryPath: string) => Promise<void>;
  wait?: (delayMs: number) => Promise<void>;
  reportCleanupError?: (error: TemporaryFileCleanupError) => void;
};

const TRANSIENT_CLEANUP_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const CLEANUP_RETRY_DELAYS_MS = [50, 100, 200, 400];

async function removeTemporaryFile(
  temporaryPath: string,
  remove: (temporaryPath: string) => Promise<void>,
  wait: (delayMs: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await remove(temporaryPath);
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'ENOENT') return;
      const delay = CLEANUP_RETRY_DELAYS_MS[attempt];
      if (!TRANSIENT_CLEANUP_CODES.has(code) || delay === undefined) throw error;
      await wait(delay);
    }
  }
}

/**
 * The scratch path a checkpoint is downloaded to before it replaces `destination`.
 *
 * Deliberately derived from the destination and nothing else. `peerDownloadFile`
 * resumes a transfer from `${downloadPath}.part`, which it stats on entry — so a
 * path that varies per call (a PID, a UUID, a clock read) silently disables
 * resume, and a multi-gigabyte checkpoint over a home link has to start from
 * zero every time the cron worker restarts. Hashing keeps the component short
 * enough for Windows' 255-character limit no matter how long the checkpoint name
 * is, which is why it is not simply `.hub-<name>`.
 */
export function temporaryDownloadPath(destination: string): string {
  const identity = createHash('sha256').update(path.basename(destination)).digest('hex').slice(0, 24);
  return path.join(path.dirname(destination), `.hub-${identity}`);
}

/**
 * Download beside the destination, verify it, then atomically replace the destination.
 *
 * Two hub processes mirroring the same job share this scratch path and will
 * fight over it — but they already raced on the final `rename`, so this adds no
 * new failure mode and is not worth locking for. One cron worker per hub is the
 * assumption throughout.
 */
export async function downloadAndReplaceFile(
  destination: string,
  reportedSize: unknown,
  download: (temporaryDestination: string) => Promise<number>,
  options: DownloadAndReplaceOptions = {},
): Promise<void> {
  const name = path.basename(destination);
  const temporaryDestination = temporaryDownloadPath(destination);
  const temporaryPart = `${temporaryDestination}.part`;
  const remove = options.remove ?? (temporaryPath => fs.promises.rm(temporaryPath, { force: true }));
  const wait = options.wait ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
  const reportCleanupError = options.reportCleanupError ?? (error => console.error(error));

  let failed = false;
  let primaryError: unknown;
  let keepResumeData = false;
  try {
    let downloaded: number;
    try {
      downloaded = await download(temporaryDestination);
    } catch (error) {
      // The transfer itself broke, so whatever bytes landed in `.part` are still
      // good and the next attempt resumes from them. Everything below this line
      // means the bytes are complete but wrong, and resuming them is pointless.
      keepResumeData = true;
      throw error;
    }
    assertDownloadedSize(name, downloaded, reportedSize);
    await fs.promises.rename(temporaryDestination, destination);
  } catch (error) {
    failed = true;
    primaryError = error;
  }

  const cleanupResults = await Promise.allSettled([
    removeTemporaryFile(temporaryDestination, remove, wait),
    ...(keepResumeData ? [] : [removeTemporaryFile(temporaryPart, remove, wait)]),
  ]);
  const cleanupFailures = cleanupResults
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason);

  if (cleanupFailures.length > 0) {
    const cleanupError = new TemporaryFileCleanupError(cleanupFailures);
    if (!failed) throw cleanupError;

    // Preserve the transfer/verification error as the thrown failure while
    // still making stranded temporary files visible to logs and callers.
    reportCleanupError(cleanupError);
    if (primaryError instanceof Error) {
      try {
        Object.defineProperty(primaryError, 'cleanupError', { value: cleanupError, configurable: true });
      } catch {
        // Reporting above still records cleanup failure for a non-extensible error.
      }
    }
  }

  if (failed) throw primaryError;
}
