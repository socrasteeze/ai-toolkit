/**
 * The machines a job can be sent to.
 *
 * Returns PEERS ONLY. The local GPU list keeps coming from `/api/gpu`, and the
 * client merges the two (`useMachines`). That split is deliberate: it leaves
 * upstream's `api/gpu/route.ts` byte-identical, and it means a slow or absent
 * peer can never delay or break the local picker.
 *
 * An unreachable peer is reported as offline with a reason, not as an error.
 * A machine that is simply switched off is an ordinary state, and the picker
 * should say so rather than hide the machine or fail the page -- the same call
 * SwarmUI's `AllowIdle` makes.
 */

import { NextResponse } from 'next/server';
import { cached } from '@/server/apiCache';
import { getPeers, savePeers, toPublic, Peer } from '@/server/peers';

/** A peer that is off should be reported quickly, not waited on. */
const PROBE_TIMEOUT_MS = 6_000;

interface MachineReport {
  id: string;
  label: string;
  url: string;
  online: boolean;
  error?: string;
  gpus: any[];
}

async function probePeer(peer: Peer): Promise<MachineReport> {
  const base: MachineReport = { id: peer.id, label: peer.label, url: peer.url, online: false, gpus: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${peer.url}/api/gpu`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: peer.token ? { Authorization: `Bearer ${peer.token}` } : {},
    });
    if (res.status === 401) {
      return { ...base, error: 'Access token rejected' };
    }
    if (!res.ok) {
      return { ...base, error: `Answered ${res.status}` };
    }
    const data = await res.json();
    return { ...base, online: true, gpus: Array.isArray(data?.gpus) ? data.gpus : [] };
  } catch (e: any) {
    return { ...base, error: e?.name === 'AbortError' ? 'No answer' : 'Not reachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function collect(): Promise<MachineReport[]> {
  const peers = await getPeers();
  // Probed together: one asleep machine must not hold up the rest of the list.
  return Promise.all(peers.map(probePeer));
}

export async function GET() {
  try {
    const machines = await cached('peer-machines', collect, 5000);
    return NextResponse.json({ machines });
  } catch (error) {
    console.error('Error listing machines:', error);
    return NextResponse.json({ machines: [], error: 'Failed to list machines' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const saved = await savePeers(body?.peers);
    return NextResponse.json({ peers: saved.map(toPublic) });
  } catch (error) {
    console.error('Error saving machines:', error);
    return NextResponse.json({ error: 'Failed to save machines' }, { status: 500 });
  }
}
