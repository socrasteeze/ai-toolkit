/**
 * The peer registry. Next-route side.
 *
 * Mirror of `cron/peers.ts` -- see that file for the shape and for why the two
 * halves cannot share a module. Stored as one JSON row in `Settings` because
 * fork rule 2 forbids Prisma schema changes for fork features.
 */

import prisma from '@/server/prisma';
import { PEER_ID_PATTERN } from '@/utils/gpuIds';

/** The settings key holding the JSON peer list. */
export const PEERS_SETTINGS_KEY = 'PEERS';

export interface Peer {
  id: string;
  label: string;
  url: string;
  token?: string;
  /** See `cron/peers.ts` — absent means "assume a case-insensitive filesystem". */
  caseSensitiveFs?: boolean;
}

/** What the browser is allowed to see. The token never leaves the server. */
export type PublicPeer = Omit<Peer, 'token'> & { hasToken: boolean };

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
  if (typeof raw.caseSensitiveFs === 'boolean') {
    peer.caseSensitiveFs = raw.caseSensitiveFs;
  }
  return peer;
}

/** Never throws: a missing or corrupt row reads as "no peers". */
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

export function toPublic(peer: Peer): PublicPeer {
  return { id: peer.id, label: peer.label, url: peer.url, hasToken: Boolean(peer.token) };
}

/**
 * Replaces the whole list.
 *
 * A peer submitted without a token keeps the one already stored, so editing a
 * label from the UI cannot silently blank the credential — the browser is never
 * sent the token and so cannot send it back.
 */
export async function savePeers(incoming: any[]): Promise<Peer[]> {
  const existing = await getPeers();
  const byId = new Map(existing.map(p => [p.id, p]));
  const next: Peer[] = [];
  const seen = new Set<string>();

  for (const entry of Array.isArray(incoming) ? incoming : []) {
    const peer = sanitize(entry);
    if (!peer || seen.has(peer.id)) {
      continue;
    }
    if (!peer.token) {
      const prior = byId.get(peer.id);
      // An explicit empty string means "clear it"; an absent key means "keep it".
      if (prior?.token && entry?.token !== '') {
        peer.token = prior.token;
      }
    }
    if (peer.caseSensitiveFs === undefined) {
      // Same reasoning as the token: the peer editor never renders this flag, so
      // an entry that comes back without it means "unchanged", not "cleared".
      const prior = byId.get(peer.id);
      if (prior?.caseSensitiveFs !== undefined) {
        peer.caseSensitiveFs = prior.caseSensitiveFs;
      }
    }
    seen.add(peer.id);
    next.push(peer);
  }

  await prisma.settings.upsert({
    where: { key: PEERS_SETTINGS_KEY },
    update: { value: JSON.stringify(next) },
    create: { key: PEERS_SETTINGS_KEY, value: JSON.stringify(next) },
  });
  return next;
}
