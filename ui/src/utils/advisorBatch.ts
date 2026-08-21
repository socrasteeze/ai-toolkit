// Fork-only helper (see FORK_NOTES.md). Bucketed datasets emit pre-batched items, so
// mixed dataset batch sizes combine as an item-weighted harmonic mean: total items /
// total microbatches per pass. This reduces to the global batch size when every dataset
// uses the same value.

export interface DatasetBatchWeight {
  itemCount: number;
  batchSize?: number | null;
}

export const weightedBatchSize = (datasets: DatasetBatchWeight[], fallbackBatchSize: number = 1): number => {
  const fallback = Math.max(1, fallbackBatchSize || 1);
  let totalItems = 0;
  let microbatchesPerPass = 0;
  for (const dataset of datasets) {
    if (!Number.isFinite(dataset.itemCount) || dataset.itemCount <= 0) continue;
    const batchSize = Math.max(1, dataset.batchSize || fallback);
    totalItems += dataset.itemCount;
    microbatchesPerPass += dataset.itemCount / batchSize;
  }
  return totalItems > 0 && microbatchesPerPass > 0 ? totalItems / microbatchesPerPass : fallback;
};
