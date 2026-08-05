/**
 * The peer registry. Worker side.
 *
 * A peer is another ai-toolkit install whose GPUs this machine may submit jobs
 * to. It runs unmodified: everything the hub needs is already a public route
 * there (`/api/jobs`, `/api/datasets/upload`, `/api/files/...`, `/api/queue/...`).
 * Nothing is installed on a peer to make it one.
 *
 * Stored as a single JSON row in `Settings`, not a table -- fork rule 2 forbids
 * Prisma schema changes for fork features. This mirrors how `getTrainingFolder`
 * and `getHFToken` already read their values.
 *
 * Mirrored in `src/server/peers.ts` for the Next routes; see `cron/gpuIds.ts`
 * for why the two sides cannot share a module.
 */

import prisma from './prisma';
import { PEER_ID_PATTERN } from './gpuIds';

/** The settings key holding the JSON peer list. */
export const PEERS_SETTINGS_KEY = 'PEERS';

export interface Peer {
  /** Stable, url-safe, no separator character. Used as the `gpu_ids` prefix. */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** Base URL of the peer's ai-toolkit UI, e.g. "http://100.80.1.2:8675". */
  url: string;
  /** The peer's AI_TOOLKIT_AUTH value, if it has one set. */
  token?: string;
}

/** Drops anything malformed rather than letting a bad row break the picker. */
function sanitize(raw: any): Peer | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
  const url = typeof raw.url === 'string' ? raw.url.trim().replace(/\/+$/, '') : '';
  if (!PEER_ID_PATTERN.test(id) || url === '') {
    return null;
  }
  const peer: Peer = {
    id,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : id,
    url,
  };
  if (typeof raw.token === 'string' && raw.token !== '') {
    peer.token = raw.token;
  }
  return peer;
}

/**
 * Every configured peer. Never throws: a missing or corrupt row reads as "no
 * peers", which degrades to today's local-only behavior instead of taking the
 * worker down.
 */
export async function getPeers(): Promise<Peer[]> {
  try {
    const row = await prisma.settings.findFirst({ where: { key: PEERS_SETTINGS_KEY } });
    if (!row?.value) {
      return [];
    }
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const peers: Peer[] = [];
    for (const entry of parsed) {
      const peer = sanitize(entry);
      if (peer) {
        peers.push(peer);
      }
    }
    return peers;
  } catch (e) {
    console.error('Could not read the peer registry:', e);
    return [];
  }
}

/** One peer by id, or null if it is not registered (or was removed mid-job). */
export async function getPeer(id: string): Promise<Peer | null> {
  const peers = await getPeers();
  return peers.find(p => p.id === id) ?? null;
}
