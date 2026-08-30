'use client';

/**
 * The full list of GPUs a job can be sent to: this machine's, plus every
 * reachable peer's.
 *
 * Local GPUs come from `useGPUInfo` and upstream's shared `/api/monitor` stream.
 * Peers come from `/api/machines`, which probes each peer's stock `/api/gpu`
 * route. Keeping peer discovery separate means a sleeping peer cannot slow down
 * or break the local half of the picker.
 *
 * Each option's `value` is exactly what goes into `Job.gpu_ids`: a bare index
 * for local, `"<peerId>:<index>"` for a peer. See `utils/gpuIds.ts`.
 */

import { useMemo, useState } from 'react';
import { apiClient } from '@/utils/api';
import usePollLoop from '@/hooks/usePollLoop';
import useGPUInfo from '@/hooks/useGPUInfo';
import { makeRemoteGpuId } from '@/utils/gpuIds';

export interface MachineReport {
  id: string;
  label: string;
  url: string;
  online: boolean;
  error?: string;
  gpus: { index: number; name: string }[];
}

export interface GpuOption {
  /** The `gpu_ids` value this option selects. */
  value: string;
  /** What the picker shows. */
  label: string;
  /**
   * react-select disables an option carrying this flag. It is not part of
   * upstream's `SelectOption` type, so call sites cast — which is cheaper than
   * adding `src/types.ts` to the fork's merge surface for one optional field.
   */
  isDisabled?: boolean;
  /** Why it is unavailable, in words a person can act on. */
  reason?: string;
  machineId: string | null;
}

const MACHINES_POLL_MS = 30_000;

export default function useMachines(reloadInterval: null | number = null) {
  const { gpuList, isGPUInfoLoaded } = useGPUInfo(null, reloadInterval);
  const [machines, setMachines] = useState<MachineReport[]>([]);
  const [areMachinesLoaded, setLoaded] = useState(false);

  const fetchMachines = async () => {
    try {
      const data = await apiClient.get('/api/machines').then(res => res.data);
      setMachines(Array.isArray(data?.machines) ? data.machines : []);
    } catch (err) {
      // A failure here must not take the local GPUs away — the picker degrades
      // to local-only, which is exactly what it was before peers existed.
      console.error(`Failed to fetch machines: ${err instanceof Error ? err.message : String(err)}`);
      setMachines([]);
    } finally {
      setLoaded(true);
    }
  };

  // Peers do not come and go on the local GPU list's cadence (typically 5 s), and
  // each probe can cost a full timeout per offline peer. Poll them no faster than
  // every 30 s; POST /api/machines invalidates the server cache so an edit still
  // shows up immediately via refreshMachines.
  const machinesInterval = reloadInterval === null ? null : Math.max(reloadInterval, MACHINES_POLL_MS);
  usePollLoop(fetchMachines, machinesInterval, []);

  const options: GpuOption[] = useMemo(() => {
    const local: GpuOption[] = gpuList.map(gpu => ({
      value: `${gpu.index}`,
      label: `GPU #${gpu.index}`,
      machineId: null,
    }));

    const remote: GpuOption[] = [];
    for (const machine of machines) {
      if (!machine.online || machine.gpus.length === 0) {
        // An unreachable machine is still listed, disabled, with the reason.
        // Hiding it looks identical to never having configured it, which is the
        // thing someone is most likely to be confused by — and it comes back on
        // its own as soon as the machine answers again.
        const reason = machine.error ?? (machine.online ? 'no GPUs reported' : 'offline');
        remote.push({
          value: makeRemoteGpuId(machine.id, '0'),
          label: `${machine.label} — ${reason}`,
          isDisabled: true,
          reason,
          machineId: machine.id,
        });
        continue;
      }
      for (const gpu of machine.gpus) {
        remote.push({
          value: makeRemoteGpuId(machine.id, `${gpu.index}`),
          label: `${machine.label} — GPU #${gpu.index}${gpu.name ? ` (${gpu.name})` : ''}`,
          machineId: machine.id,
        });
      }
    }
    return [...local, ...remote];
  }, [gpuList, machines]);

  // Deliberately reports LOCAL readiness only. Callers gate the whole job form
  // on this, and a peer that is switched off takes the full probe timeout to
  // answer — waiting on it would stall the form for everyone who has one
  // configured, to add options they were not necessarily going to use.
  return {
    gpuList,
    machines,
    options,
    isGPUInfoLoaded,
    areMachinesLoaded,
    refreshMachines: fetchMachines,
  };
}
