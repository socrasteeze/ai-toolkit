import { smiNumber } from '@/server/smiNumber';
import type { GpuInfo } from '@/types';

// Power limits for GPUs whose driver reports none (nvidia-smi gives [N/A]).
// These unified SoCs have no settable GPU limit, so show the rated TDP of the
// whole chip. GB10 (DGX Spark) is 140 W. RTX Spark N1X: the 5120-core part is
// laptop-only, rated 45-80 W (OEM configurable); the 6144-core part is 140 W
// on desktop and 45-80 W in laptops but shares its name, so it falls through
// to the desktop figure.
const KNOWN_POWER_LIMITS_W: [RegExp, number][] = [
  [/\bGB10\b/, 140],
  [/RTX Spark.*5120-core/, 80],
  [/RTX Spark/, 140],
];

function knownPowerLimit(name: string): number {
  return KNOWN_POWER_LIMITS_W.find(([re]) => re.test(name))?.[1] ?? NaN;
}

function roundedSmi(raw: string | undefined): number | null {
  const value = smiNumber(raw, true);
  return value == null ? null : Math.round(value);
}

/**
 * One nvidia-smi CSV row. Fields are comma-separated; the space after each
 * comma is not guaranteed. Temperature is a float (for example 65.19) and is
 * stored rounded, matching the integer the widget shows.
 */
export function parseGpuLine(line: string): GpuInfo | null {
  const [
    index,
    name,
    driverVersion,
    temperature,
    gpuUtil,
    memoryUtil,
    memoryTotal,
    memoryFree,
    memoryUsed,
    powerDraw,
    powerLimit,
    clockGraphics,
    clockMemory,
    fanSpeed,
  ] = line.split(',').map(item => item.trim());
  const indexN = smiNumber(index);
  if (indexN === null) return null;
  const reportedLimit = smiNumber(powerLimit, true);
  const fallbackLimit = knownPowerLimit(name);
  return {
    index: indexN,
    name,
    driverVersion,
    temperature: roundedSmi(temperature),
    utilization: {
      gpu: smiNumber(gpuUtil),
      memory: smiNumber(memoryUtil),
    },
    memory: {
      total: smiNumber(memoryTotal),
      free: smiNumber(memoryFree),
      used: smiNumber(memoryUsed),
    },
    power: {
      draw: smiNumber(powerDraw, true),
      limit: reportedLimit ?? (Number.isFinite(fallbackLimit) ? fallbackLimit : null),
    },
    clocks: {
      graphics: smiNumber(clockGraphics),
      memory: smiNumber(clockMemory),
    },
    fan: {
      speed: smiNumber(fanSpeed),
    },
  };
}

/**
 * Name and index parsed, but every live sensor is missing. A named TDP
 * fallback does not count: GB10 still looks blank when the driver sent no
 * readings. A real zero (idle, fan stopped) is not blank.
 */
export function gpuSensorsBlank(gpu: GpuInfo): boolean {
  const fallback = knownPowerLimit(gpu.name);
  const limitBlank = gpu.power.limit == null || (Number.isFinite(fallback) && gpu.power.limit === fallback);
  return (
    gpu.temperature == null &&
    gpu.utilization.gpu == null &&
    gpu.utilization.memory == null &&
    gpu.memory.total == null &&
    gpu.memory.free == null &&
    gpu.memory.used == null &&
    gpu.power.draw == null &&
    limitBlank &&
    gpu.clocks.graphics == null &&
    gpu.clocks.memory == null &&
    gpu.fan.speed == null
  );
}
