'use client';

// Fork-only component (see FORK_NOTES.md). Shows an advisory step-count suggestion under
// the Steps field on the new-job form, computed from the selected datasets' file counts
// and the selected model architecture. Never changes the field on its own — the user
// applies it explicitly.

import { useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/utils/api';
import { JobConfig } from '@/types';
import { suggestSteps } from '@/utils/stepSuggestion';
import { defaultDatasetConfig } from '@/app/jobs/new/jobConfig';

type Props = {
  jobConfig: JobConfig;
  setJobConfig: (value: any, key: string) => void;
};

// counts are cached per dataset folder name for the lifetime of the page
const countCache = new Map<string, number>();
const inFlight = new Map<string, Promise<number>>();

const fetchCount = (datasetName: string): Promise<number> => {
  if (countCache.has(datasetName)) {
    return Promise.resolve(countCache.get(datasetName) as number);
  }
  if (inFlight.has(datasetName)) {
    return inFlight.get(datasetName) as Promise<number>;
  }
  const promise = apiClient
    .post('/api/datasets/count', { datasetName })
    .then(res => {
      const total = res.data?.totalCount ?? 0;
      countCache.set(datasetName, total);
      return total;
    })
    .catch(() => -1)
    .finally(() => {
      inFlight.delete(datasetName);
    });
  inFlight.set(datasetName, promise);
  return promise;
};

const folderPathToDatasetName = (folderPath: string): string | null => {
  if (!folderPath || folderPath === defaultDatasetConfig.folder_path) return null;
  const name = folderPath.split(/[\\/]/).filter(Boolean).pop();
  return name || null;
};

export default function StepSuggestion({ jobConfig, setJobConfig }: Props) {
  const process = jobConfig.config.process[0];
  const datasets = process.datasets || [];
  const arch = process.model.arch;
  const batchSize = process.train.batch_size;
  const gradAccum = process.train.gradient_accumulation;
  const currentSteps = process.train.steps;

  const datasetInputs = useMemo(() => {
    return datasets
      .map(d => ({ name: folderPathToDatasetName(d.folder_path), numRepeats: d.num_repeats || 1 }))
      .filter(d => d.name !== null) as { name: string; numRepeats: number }[];
  }, [datasets]);

  const datasetsKey = datasetInputs.map(d => d.name).join('|');
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    const names = datasetInputs.map(d => d.name);
    if (names.length === 0) {
      setCounts({});
      return;
    }
    Promise.all(names.map(name => fetchCount(name).then(count => [name, count] as const))).then(results => {
      if (cancelled) return;
      const next: Record<string, number> = {};
      for (const [name, count] of results) {
        next[name] = count;
      }
      setCounts(next);
    });
    return () => {
      cancelled = true;
    };
  }, [datasetsKey]);

  const itemCount = useMemo(() => {
    let total = 0;
    for (const d of datasetInputs) {
      const count = counts[d.name];
      if (count === undefined || count < 0) continue;
      total += count * d.numRepeats;
    }
    return total;
  }, [datasetInputs, counts]);

  const suggestion = useMemo(() => {
    return suggestSteps({ itemCount, arch, batchSize, gradientAccumulation: gradAccum });
  }, [itemCount, arch, batchSize, gradAccum]);

  if (!suggestion) return null;

  return (
    <div className="text-xs text-gray-400 pt-1" title={suggestion.explanation}>
      {itemCount} training files → suggested ~{suggestion.suggested} steps ({suggestion.low}–{suggestion.high}) · ≈
      {suggestion.epochsEquivalent} passes over the data
      {currentSteps !== suggestion.suggested && (
        <button
          type="button"
          className="ml-2 text-blue-400 hover:text-blue-300 underline"
          onClick={() => setJobConfig(suggestion.suggested, 'config.process[0].train.steps')}
        >
          Apply
        </button>
      )}
    </div>
  );
}
