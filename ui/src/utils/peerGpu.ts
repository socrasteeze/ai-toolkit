import type { GpuInfo } from '@/types';
import { splitPeerGpu } from '@/utils/gpuIds';

export interface PeerMachineGpus {
  id: string;
  label: string;
  online: boolean;
  gpus: unknown[];
}

export interface PeerGpuCard {
  key: string;
  label: string;
  gpu: GpuInfo;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Keep every field a peer reported. Missing or non-numeric sensors become null so the widget can show "-". */
export function coerceGpuInfo(raw: unknown, fallbackIndex: number): GpuInfo {
  const gpu = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {};
  const utilization = gpu.utilization && typeof gpu.utilization === 'object' ? gpu.utilization : {};
  const memory = gpu.memory && typeof gpu.memory === 'object' ? gpu.memory : {};
  const power = gpu.power && typeof gpu.power === 'object' ? gpu.power : {};
  const clocks = gpu.clocks && typeof gpu.clocks === 'object' ? gpu.clocks : {};
  const fan = gpu.fan && typeof gpu.fan === 'object' ? gpu.fan : {};
  const index = finite(gpu.index);
  return {
    index: index === null ? fallbackIndex : index,
    name: typeof gpu.name === 'string' && gpu.name !== '' ? gpu.name : 'GPU',
    driverVersion: typeof gpu.driverVersion === 'string' ? gpu.driverVersion : '',
    temperature: finite(gpu.temperature),
    utilization: { gpu: finite(utilization.gpu), memory: finite(utilization.memory) },
    memory: {
      total: finite(memory.total),
      free: finite(memory.free),
      used: finite(memory.used),
      ...(memory.shared === true ? { shared: true } : {}),
    },
    power: { draw: finite(power.draw), limit: finite(power.limit) },
    clocks: { graphics: finite(clocks.graphics), memory: finite(clocks.memory) },
    fan: { speed: finite(fan.speed) },
  };
}

export function peerGpuCards(machines: PeerMachineGpus[]): PeerGpuCard[] {
  const cards: PeerGpuCard[] = [];
  for (const machine of machines) {
    if (!machine.online || !Array.isArray(machine.gpus)) continue;
    machine.gpus.forEach((raw, i) => {
      const gpu = coerceGpuInfo(raw, i);
      cards.push({ key: `${machine.id}:${gpu.index}`, label: machine.label, gpu });
    });
  }
  return cards;
}

/** The first GPU this job named on its peer, or null when that machine is offline or reported none. */
export function peerGpuForIds(gpuIds: string | null | undefined, machines: PeerMachineGpus[]): PeerGpuCard | null {
  const split = splitPeerGpu(gpuIds);
  if (!split) return null;
  const machine = machines.find(item => item.id === split.peerId && item.online);
  if (!machine || !Array.isArray(machine.gpus) || machine.gpus.length === 0) return null;
  const wanted = new Set(split.localGpuIds.split(',').map(part => part.trim()));
  const match = machine.gpus.find(raw => {
    const index = raw && typeof raw === 'object' ? (raw as { index?: unknown }).index : undefined;
    return wanted.has(String(index));
  });
  const gpu = coerceGpuInfo(match ?? machine.gpus[0], 0);
  return { key: `${machine.id}:${gpu.index}`, label: machine.label, gpu };
}
