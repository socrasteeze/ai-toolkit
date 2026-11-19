import React, { useMemo } from 'react';
import Loading from '@/components/Loading';
import GPUWidget from '@/components/GPUWidget';
import useMonitorStream from '@/hooks/useMonitorStream';
// fork addition, see FORK_NOTES.md — peer cards use the same widget as the local GPU
import usePeerMachines from '@/hooks/usePeerMachines';
import { peerGpuCards } from '@/utils/peerGpu';

const GpuMonitor: React.FC = () => {
  // Live samples arrive every MONITOR_TICK_MS over the shared /api/monitor SSE stream
  const { gpu: gpuData, lastUpdated } = useMonitorStream();
  const machines = usePeerMachines(5000);
  const peerCards = useMemo(() => peerGpuCards(machines), [machines]);
  const loading = gpuData === null && peerCards.length === 0;
  const error = null;

  const getGridClasses = (gpuCount: number): string => {
    switch (gpuCount) {
      case 1:
        return 'grid-cols-1';
      case 2:
        return 'grid-cols-1 sm:grid-cols-2';
      case 3:
        return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
      case 4:
        return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4';
      case 5:
      case 6:
        return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
      case 7:
      case 8:
        return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4';
      case 9:
      case 10:
        return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-5';
      default:
        return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
    }
  };

  console.log('state', {
    loading,
    gpuData,
    error,
    lastUpdated,
  });

  const content = useMemo(() => {
    const localGpus = gpuData?.gpus ?? [];
    const cards = [
      ...localGpus.map(gpu => ({ key: `local-${gpu.index}`, gpu, machineLabel: undefined as string | undefined })),
      ...peerCards.map(card => ({ key: card.key, gpu: card.gpu, machineLabel: card.label })),
    ];

    if (loading && cards.length === 0) {
      return <Loading />;
    }

    if (error) {
      return (
        <div className="bg-red-900 border border-red-600 text-red-200 px-4 py-3 rounded relative" role="alert">
          <strong className="font-bold">Error!</strong>
          <span className="block sm:inline"> {error}</span>
        </div>
      );
    }

    if (cards.length === 0 && !gpuData) {
      return (
        <div className="bg-yellow-900 border border-yellow-700 text-yellow-300 px-4 py-3 rounded relative" role="alert">
          <span className="block sm:inline">No GPU data available.</span>
        </div>
      );
    }

    if (cards.length === 0 && gpuData && !gpuData.hasNvidiaSmi && !gpuData.isMac) {
      return (
        <div className="bg-yellow-900 border border-yellow-700 text-yellow-300 px-4 py-3 rounded relative" role="alert">
          <strong className="font-bold">No NVIDIA GPUs detected!</strong>
          <span className="block sm:inline"> nvidia-smi is not available on this system.</span>
          {gpuData.error && <p className="mt-2 text-sm">{gpuData.error}</p>}
        </div>
      );
    }

    if (cards.length === 0) {
      return (
        <div className="bg-yellow-900 border border-yellow-700 text-yellow-300 px-4 py-3 rounded relative" role="alert">
          <span className="block sm:inline">No GPUs found, but nvidia-smi is available.</span>
        </div>
      );
    }

    const gridClass = getGridClasses(cards.length);

    return (
      <div className={`grid ${gridClass} gap-3`}>
        {cards.map(card => (
          <GPUWidget key={card.key} gpu={card.gpu} machineLabel={card.machineLabel} />
        ))}
      </div>
    );
  }, [loading, gpuData, error, peerCards]);

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-2">
        <h1 className="text-md">GPU Monitor</h1>
        <div className="text-xs text-gray-500">Last updated: {lastUpdated?.toLocaleTimeString()}</div>
      </div>
      {content}
    </div>
  );
};

export default GpuMonitor;
