import React from 'react';
import { GpuInfo } from '@/types';
import { Thermometer, Zap, Clock, HardDrive, Fan, Cpu } from 'lucide-react';

interface GPUWidgetProps {
  gpu: GpuInfo;
  /** Set when this card is a peer machine, so two "#0" GPUs stay distinct. */
  machineLabel?: string;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export default function GPUWidget({ gpu, machineLabel }: GPUWidgetProps) {
  const formatMemory = (mb: number): string => {
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
  };

  const getUtilizationColor = (value: number): string => {
    return value < 30 ? 'bg-emerald-500' : value < 70 ? 'bg-amber-500' : 'bg-rose-500';
  };

  const getTemperatureColor = (temp: number): string => {
    return temp < 50 ? 'text-emerald-500' : temp < 80 ? 'text-amber-500' : 'text-rose-500';
  };

  const temperature = finite(gpu.temperature);
  const fanSpeed = finite(gpu.fan?.speed);
  const load = finite(gpu.utilization?.gpu);
  const used = finite(gpu.memory?.used);
  const total = finite(gpu.memory?.total);
  const memoryPct = used !== null && total !== null && total > 0 ? (used / total) * 100 : null;
  const clock = finite(gpu.clocks?.graphics);
  const draw = finite(gpu.power?.draw);
  const limit = finite(gpu.power?.limit);

  return (
    <div className="bg-gray-900 rounded-xl shadow-lg overflow-hidden border border-gray-800">
      <div className="bg-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-2 min-w-0">
          <h2 className="font-semibold text-gray-100 truncate">{gpu.name}</h2>
          {machineLabel ? (
            <span className="px-2 py-0.5 bg-gray-700 rounded-full text-xs text-gray-300 flex-shrink-0">
              {machineLabel}
            </span>
          ) : null}
          <span className="px-2 py-0.5 bg-gray-700 rounded-full text-xs text-gray-300 flex-shrink-0">
            # {gpu.index}
          </span>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Temperature, Fan, and Utilization Section */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <Thermometer className={`w-4 h-4 ${temperature === null ? 'text-gray-400' : getTemperatureColor(temperature)}`} />
              <div>
                <p className="text-xs text-gray-400">Temperature</p>
                <p className={`text-sm font-medium ${temperature === null ? 'text-gray-400' : getTemperatureColor(temperature)}`}>
                  {temperature === null ? '-' : `${temperature}°C`}
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <Fan className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <div>
                <p className="text-xs text-gray-400">Fan Speed</p>
                <p className="text-sm font-medium text-blue-600 dark:text-blue-400">
                  {fanSpeed === null ? '-' : `${fanSpeed}%`}
                </p>
              </div>
            </div>
          </div>
          <div>
            <div className="flex items-center space-x-2 mb-1">
              <Cpu className="w-4 h-4 text-gray-400" />
              <p className="text-xs text-gray-400">GPU Load</p>
              <span className="text-xs text-gray-300 ml-auto">{load === null ? '-' : `${load}%`}</span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-1">
              <div
                className={`h-1 rounded-full transition-all ${getUtilizationColor(load ?? 0)}`}
                style={{ width: `${load ?? 0}%` }}
              />
            </div>
            <div className="flex items-center space-x-2 mb-1 mt-3">
              <HardDrive className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <p className="text-xs text-gray-400">{gpu.memory?.shared ? 'Shared Memory' : 'Memory'}</p>
              <span className="text-xs text-gray-300 ml-auto">
                {memoryPct === null ? '-' : `${memoryPct.toFixed(1)}%`}
              </span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-1">
              <div
                className="h-1 rounded-full bg-blue-500 transition-all"
                style={{ width: `${memoryPct ?? 0}%` }}
              />
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              {used === null || total === null ? '-' : `${formatMemory(used)} / ${formatMemory(total)}`}
            </p>
          </div>
        </div>

        {/* Power and Clocks Section */}
        <div className="grid grid-cols-2 gap-4 pt-2 border-t border-gray-800">
          <div className="flex items-start space-x-2">
            <Clock className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            <div>
              <p className="text-xs text-gray-400">Clock Speed</p>
              <p className="text-sm text-gray-200">{clock === null ? '-' : `${clock} MHz`}</p>
            </div>
          </div>
          <div className="flex items-start space-x-2">
            <Zap className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="text-xs text-gray-400">Power Draw</p>
              <p className="text-sm text-gray-200">
                {draw === null ? '-' : `${draw.toFixed(1)}W`}
                <span className="text-gray-400 text-xs"> / {limit === null ? '-' : `${limit.toFixed(1)}W`}</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
