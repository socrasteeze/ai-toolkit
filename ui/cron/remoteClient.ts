/**
 * HTTP client for a peer ai-toolkit instance.
 *
 * The peer is driven entirely through routes it already exposes -- there is no
 * side-channel protocol and nothing is installed on it. That is deliberate: it
 * is the property that makes SwarmUI's remote-instance backend cheap to
 * maintain, and it means a peer can be upgraded, reinstalled or replaced
 * without this file changing.
 *
 * Every failure path here reports what actually went wrong. A remote runner
 * that invents a success, or a return code it never saw, turns a five-minute
 * diagnosis into an afternoon -- see the sibling project's `rc=0` bug, where a
 * hard-coded placeholder made every remote failure report the same meaningless
 * exit status.
 */

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Peer } from './peers';

/** Default ceiling for a control-plane call. Downloads set their own. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** A large file is fetched in resumable slices; this bounds one attempt's stall. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** How many times a download may resume before it is called a failure. */
const DOWNLOAD_MAX_ATTEMPTS = 100;

/** Named so a caller can tell "the peer said no" from "the peer is not there". */
export class PeerError extends Error {
  readonly peerId: string;
  readonly status?: number;

  constructor(message: string, peerId: string, status?: number) {
    super(message);
    this.name = 'PeerError';
    this.peerId = peerId;
    this.status = status;
  }
}

function authHeaders(peer: Peer): Record<string, string> {
  if (!peer.token) {
    return {};
  }
  return { Authorization: `Bearer ${peer.token}` };
}

/**
 * One request to a peer, with a timeout and an error that names the machine.
 *
 * `fetch` rejects with a bare "fetch failed" for every transport problem, which
 * is useless in a log that covers several machines -- so the peer id and the
 * URL are always attached.
 */
export async function peerFetch(
  peer: Peer,
  pathAndQuery: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const url = `${peer.url}${pathAndQuery}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { ...authHeaders(peer), ...((init.headers as Record<string, string>) ?? {}) },
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new PeerError(`${peer.label} did not answer ${pathAndQuery} within ${timeoutMs / 1000}s`, peer.id);
    }
    throw new PeerError(`Could not reach ${peer.label} at ${url}: ${e?.message ?? e}`, peer.id);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A JSON call. A non-2xx answer becomes a PeerError carrying the status and a
 * snippet of the body, because the peer's own error text is usually the whole
 * diagnosis (a 401 means the token is wrong, a 409 means the job name is taken).
 */
export async function peerJson<T = any>(
  peer: Peer,
  pathAndQuery: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const res = await peerFetch(peer, pathAndQuery, init, timeoutMs);
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.trim().slice(0, 400);
    throw new PeerError(
      `${peer.label} refused ${pathAndQuery} with ${res.status}${snippet ? `: ${snippet}` : ''}`,
      peer.id,
      res.status,
    );
  }
  if (text.trim() === '') {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PeerError(
      `${peer.label} answered ${pathAndQuery} with ${text.length} bytes that are not JSON`,
      peer.id,
      res.status,
    );
  }
}

/** Liveness plus a GPU list, used by the picker and before a dispatch. */
export async function peerGpuInfo(peer: Peer, timeoutMs = 8_000): Promise<any> {
  return peerJson(peer, '/api/gpu', {}, timeoutMs);
}

/**
 * Uploads files into a dataset folder on the peer.
 *
 * The peer's upload route sanitizes each filename with
 * `replace(/[^a-zA-Z0-9.-]/g, '_')`. An image and its caption get the same
 * transform, so a pair that matched here still matches there -- but a name that
 * relied on other characters to be unique can collide. Callers stage into a
 * per-job folder so a collision can only ever be with this job's own files.
 */
export async function peerUploadFiles(
  peer: Peer,
  datasetName: string,
  files: { localPath: string; name: string }[],
  timeoutMs = 5 * 60_000,
): Promise<void> {
  if (files.length === 0) {
    return;
  }
  const form = new FormData();
  form.append('datasetName', datasetName);
  for (const file of files) {
    const bytes = await fs.promises.readFile(file.localPath);
    form.append('files', new Blob([new Uint8Array(bytes)]), file.name);
  }
  await peerJson(peer, '/api/datasets/upload', { method: 'POST', body: form as any }, timeoutMs);
}

/**
 * Downloads one file off the peer, resuming on a dropped connection.
 *
 * Resume is not a nicety. The sibling project measured an 85 MB checkpoint
 * needing roughly 100 resumed connections over a home link; a single-shot GET
 * would simply never finish. The peer's file route sets `Accept-Ranges` and
 * serves an open-ended `bytes=N-` to EOF, so each attempt continues rather than
 * restarting.
 *
 * `/api/files/` is exempt from the peer's auth middleware, so this works
 * whether or not the peer has a token set.
 */
export async function peerDownloadFile(
  peer: Peer,
  remoteAbsolutePath: string,
  destPath: string,
): Promise<number> {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part`;

  let have = 0;
  try {
    have = (await fs.promises.stat(partPath)).size;
  } catch {
    have = 0;
  }

  let total: number | null = null;
  let lastError: string = 'no attempt was made';

  for (let attempt = 0; attempt < DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    if (total !== null && have >= total) {
      break;
    }
    let res: Response;
    try {
      res = await peerFetch(
        peer,
        `/api/files/${encodeURIComponent(remoteAbsolutePath)}`,
        { headers: have > 0 ? { Range: `bytes=${have}-` } : {} },
        DOWNLOAD_TIMEOUT_MS,
      );
    } catch (e: any) {
      lastError = e?.message ?? String(e);
      continue;
    }

    if (res.status === 404) {
      throw new PeerError(`${peer.label} has no file at ${remoteAbsolutePath}`, peer.id, 404);
    }
    // 416 means we already hold every byte the peer has.
    if (res.status === 416) {
      total = have;
      break;
    }
    if (!res.ok && res.status !== 206) {
      lastError = `status ${res.status}`;
      continue;
    }

    if (total === null) {
      const contentRange = res.headers.get('content-range');
      const match = contentRange?.match(/\/(\d+)\s*$/);
      if (match) {
        total = parseInt(match[1], 10);
      } else {
        const len = res.headers.get('content-length');
        if (len) {
          total = have + parseInt(len, 10);
        }
      }
    }

    // A server that ignored the Range header restarts the file; drop what we
    // held rather than appending a second copy onto the first.
    if (have > 0 && res.status !== 206) {
      await fs.promises.rm(partPath, { force: true });
      have = 0;
    }

    if (!res.body) {
      lastError = 'the peer sent an empty body';
      continue;
    }

    try {
      await pipeline(
        Readable.fromWeb(res.body as any),
        fs.createWriteStream(partPath, { flags: have > 0 ? 'a' : 'w' }),
      );
    } catch (e: any) {
      lastError = e?.message ?? String(e);
    }

    try {
      have = (await fs.promises.stat(partPath)).size;
    } catch {
      have = 0;
    }
  }

  if (total !== null && have < total) {
    throw new PeerError(
      `Downloading ${path.basename(remoteAbsolutePath)} from ${peer.label} stalled at ${have}/${total} bytes ` +
        `after ${DOWNLOAD_MAX_ATTEMPTS} attempts (last error: ${lastError})`,
      peer.id,
    );
  }
  if (total === null && have === 0) {
    throw new PeerError(
      `Could not download ${path.basename(remoteAbsolutePath)} from ${peer.label} (last error: ${lastError})`,
      peer.id,
    );
  }

  await fs.promises.rename(partPath, destPath);
  return have;
}
