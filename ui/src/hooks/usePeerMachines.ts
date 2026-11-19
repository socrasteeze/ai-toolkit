'use client';

import { useState } from 'react';
import { apiClient } from '@/utils/api';
import usePollLoop from '@/hooks/usePollLoop';
import type { PeerMachineGpus } from '@/utils/peerGpu';

/**
 * Peer GPU lists from the hub's `/api/machines?live=1` probe of each peer's
 * `/api/gpu`. The picker keeps the slower uncached-cadence call in `useMachines`.
 * `intervalMs` of null fetches once.
 */
export default function usePeerMachines(intervalMs: number | null = 5000): PeerMachineGpus[] {
  const [machines, setMachines] = useState<PeerMachineGpus[]>([]);

  const fetchMachines = async () => {
    if (intervalMs == null) return;
    try {
      const data = await apiClient.get('/api/machines?live=1').then(res => res.data);
      setMachines(Array.isArray(data?.machines) ? data.machines : []);
    } catch (err) {
      console.error(`Failed to fetch peer GPUs: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  usePollLoop(fetchMachines, intervalMs, []);
  return machines;
}
