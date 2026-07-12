'use client';

// Fork-only component (see FORK_NOTES.md). Shows an advisory step-count suggestion under
// the Steps field on the new-job form, computed from the selected datasets' file counts
// and the selected model architecture, plus an on-demand dataset analyzer (exposure gauge,
// bucket-vs-batch warnings, resolution/caption checks, per-arch recommended settings —
// PLAN.md Phase 2). Never changes a field on its own — the user applies explicitly.

import { useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/utils/api';
import { JobConfig } from '@/types';
import {
  suggestSteps,
  exposureGauge,
  analyzeBuckets,
  resolutionAdvice,
  getArchRecipe,
} from '@/utils/stepSuggestion';
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

interface DatasetAnalysis {
  imageCount: number;
  dimensionCounts: Record<string, number>;
  missingCaptions: number;
  unreadable: number;
}

// analysis results cached per dataset folder name for the lifetime of the page
const analysisCache = new Map<string, DatasetAnalysis>();

const fetchAnalysis = async (datasetName: string): Promise<DatasetAnalysis | null> => {
  if (analysisCache.has(datasetName)) return analysisCache.get(datasetName) as DatasetAnalysis;
  try {
    const res = await apiClient.post('/api/datasets/analyze', { datasetName });
    const analysis = res.data as DatasetAnalysis;
    analysisCache.set(datasetName, analysis);
    return analysis;
  } catch {
    return null;
  }
};

const folderPathToDatasetName = (folderPath: string): string | null => {
  if (!folderPath || folderPath === defaultDatasetConfig.folder_path) return null;
  const name = folderPath.split(/[\\/]/).filter(Boolean).pop();
  return name || null;
};

const bandColor: Record<string, string> = {
  cool: 'text-sky-400',
  healthy: 'text-green-400',
  warm: 'text-orange-400',
  fry: 'text-red-400',
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
  const [analyses, setAnalyses] = useState<Record<string, DatasetAnalysis>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);

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

  const runAnalysis = async () => {
    setAnalyzing(true);
    setShowAnalysis(true);
    const results: Record<string, DatasetAnalysis> = {};
    for (const d of datasetInputs) {
      const analysis = await fetchAnalysis(d.name);
      if (analysis) results[d.name] = analysis;
    }
    setAnalyses(results);
    setAnalyzing(false);
  };

  // merged histogram across selected datasets (num_repeats multiplies image weight,
  // matching how the trainer duplicates the file list)
  const merged = useMemo(() => {
    const dimensionCounts: Record<string, number> = {};
    let imageCount = 0;
    let missingCaptions = 0;
    let unreadable = 0;
    for (const d of datasetInputs) {
      const a = analyses[d.name];
      if (!a) continue;
      imageCount += a.imageCount * d.numRepeats;
      missingCaptions += a.missingCaptions;
      unreadable += a.unreadable;
      for (const [dims, count] of Object.entries(a.dimensionCounts)) {
        dimensionCounts[dims] = (dimensionCounts[dims] || 0) + count * d.numRepeats;
      }
    }
    return { dimensionCounts, imageCount, missingCaptions, unreadable };
  }, [datasetInputs, analyses]);

  const resolutions = useMemo(() => {
    const set = new Set<number>();
    for (const d of datasets) {
      for (const r of d.resolution || []) set.add(r);
    }
    return [...set].sort((a, b) => a - b);
  }, [datasets]);

  const gauge = useMemo(() => {
    return exposureGauge({ itemCount, arch, steps: currentSteps, batchSize, gradientAccumulation: gradAccum });
  }, [itemCount, arch, currentSteps, batchSize, gradAccum]);

  const bucketAnalyses = useMemo(() => {
    if (Object.keys(merged.dimensionCounts).length === 0) return [];
    return resolutions.map(res => analyzeBuckets(merged.dimensionCounts, res, batchSize));
  }, [merged, resolutions, batchSize]);

  const resAdvice = useMemo(() => {
    if (Object.keys(merged.dimensionCounts).length === 0) return null;
    return resolutionAdvice(merged.dimensionCounts, resolutions);
  }, [merged, resolutions]);

  const modelPath = process.model.name_or_path || '';
  const recipe = useMemo(() => getArchRecipe(arch, itemCount, modelPath), [arch, itemCount, modelPath]);
  const hasAnalysis = Object.keys(analyses).length > 0;

  if (!suggestion) return null;

  return (
    <div className="text-xs text-gray-400 pt-1">
      <div title={suggestion.explanation}>
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
        <button
          type="button"
          className="ml-2 text-blue-400 hover:text-blue-300 underline"
          onClick={() => (showAnalysis && hasAnalysis ? setShowAnalysis(false) : runAnalysis())}
          disabled={analyzing}
        >
          {analyzing ? 'Analyzing…' : showAnalysis && hasAnalysis ? 'Hide analysis' : 'Analyze dataset'}
        </button>
      </div>

      {gauge && (
        <div className="pt-1">
          <span className={bandColor[gauge.band]}>
            {gauge.exposures} exposures/image — {gauge.label}
          </span>{' '}
          ({currentSteps} steps · eff. batch {Math.max(1, batchSize || 1) * Math.max(1, gradAccum || 1)} · {itemCount}{' '}
          files)
        </div>
      )}

      {showAnalysis && hasAnalysis && (
        <div className="mt-2 p-2 rounded border border-gray-700 bg-gray-900/50 space-y-2">
          <div>
            {merged.imageCount} images scanned
            {merged.missingCaptions > 0 && (
              <span className="text-orange-400"> · ⚠️ {merged.missingCaptions} missing captions</span>
            )}
            {merged.unreadable > 0 && <span> · {merged.unreadable} unreadable</span>}
          </div>

          {resAdvice && <div className="text-orange-400">⚠️ {resAdvice}</div>}

          {bucketAnalyses.map(ba => (
            <div key={ba.resolution}>
              <div className="text-gray-300">
                Resolution {ba.resolution}: {ba.buckets.length} bucket{ba.buckets.length !== 1 ? 's' : ''}
                {ba.upscaled > 0 && <span className="text-orange-400"> · {ba.upscaled} images upscaled</span>}
              </div>
              <div className="text-gray-500">
                {ba.buckets
                  .slice(0, 8)
                  .map(b => `${b.width}×${b.height}: ${b.count}`)
                  .join('  ·  ')}
                {ba.buckets.length > 8 && `  ·  +${ba.buckets.length - 8} more`}
              </div>
              {ba.thin.map(b => (
                <div key={`${b.width}x${b.height}`} className="text-orange-400">
                  ⚠️ Bucket {b.width}×{b.height} holds {b.count} image{b.count !== 1 ? 's' : ''} &lt; batch {batchSize} —
                  lower the batch size or add images at this aspect ratio
                </div>
              ))}
            </div>
          ))}

          {recipe && (
            <div className="border-t border-gray-700 pt-2">
              <div className="text-gray-300">Suggested settings for {arch}:</div>
              <div className="text-gray-500">{recipe.notes}</div>
              <div className="pt-1">
                {recipe.settings.map(s => (
                  <button
                    key={s.path}
                    type="button"
                    className="mr-2 mb-1 px-2 py-0.5 rounded border border-gray-600 text-blue-400 hover:text-blue-300 hover:border-gray-500"
                    onClick={() => setJobConfig(s.value, s.path)}
                  >
                    {s.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="mr-2 mb-1 px-2 py-0.5 rounded border border-gray-600 text-blue-400 hover:text-blue-300 hover:border-gray-500"
                  onClick={() => {
                    for (const s of recipe.settings) setJobConfig(s.value, s.path);
                  }}
                >
                  Apply all
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
