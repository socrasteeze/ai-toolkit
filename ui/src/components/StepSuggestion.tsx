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
import useSettings from '@/hooks/useSettings';

type Props = {
  jobConfig: JobConfig;
  setJobConfig: (value: any, key: string) => void;
};

interface DatasetSelection {
  key: string; // "datasetName" or "datasetName::subPath" — unique per selected folder
  datasetName: string;
  subPath: string; // "" for the dataset's own root
  numRepeats: number;
}

// counts are cached per selection key ("datasetName" or "datasetName::subPath") for the
// lifetime of the page
const countCache = new Map<string, number>();
const inFlight = new Map<string, Promise<number>>();

const fetchCount = (datasetName: string, subPath: string): Promise<number> => {
  const key = subPath ? `${datasetName}::${subPath}` : datasetName;
  if (countCache.has(key)) {
    return Promise.resolve(countCache.get(key) as number);
  }
  if (inFlight.has(key)) {
    return inFlight.get(key) as Promise<number>;
  }
  const promise = apiClient
    .post('/api/datasets/count', { datasetName, subPath })
    .then(res => {
      const total = res.data?.totalCount ?? 0;
      countCache.set(key, total);
      return total;
    })
    .catch(() => -1)
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
};

interface DatasetAnalysis {
  imageCount: number;
  dimensionCounts: Record<string, number>;
  missingCaptions: number;
  unreadable: number;
}

// analysis results cached per selection key for the lifetime of the page
const analysisCache = new Map<string, DatasetAnalysis>();

const fetchAnalysis = async (datasetName: string, subPath: string): Promise<DatasetAnalysis | null> => {
  const key = subPath ? `${datasetName}::${subPath}` : datasetName;
  if (analysisCache.has(key)) return analysisCache.get(key) as DatasetAnalysis;
  try {
    const res = await apiClient.post('/api/datasets/analyze', { datasetName, subPath });
    const analysis = res.data as DatasetAnalysis;
    analysisCache.set(key, analysis);
    return analysis;
  } catch {
    return null;
  }
};

// Splits an absolute folder_path into the top-level dataset name (the first segment
// under DATASETS_FOLDER) and the subPath below it, so counts/analysis reflect the
// actually-selected folder — including a nested one picked via the folder-browser
// modal — rather than always the whole top-level dataset. Previously this took just
// the LAST path segment as "the dataset name", which broke for nested selections (it
// queried for a dataset literally named after the subfolder, got a 404, and the whole
// suggestion panel disappeared since itemCount fell to 0) — see PLAN.md.
const deriveDatasetSelection = (folderPath: string, datasetsRoot: string): { datasetName: string; subPath: string } | null => {
  if (!folderPath || !datasetsRoot || folderPath === defaultDatasetConfig.folder_path) return null;
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const root = normalize(datasetsRoot);
  const full = normalize(folderPath);
  if (full !== root && !full.startsWith(`${root}/`)) return null;
  const rest = full.slice(root.length).replace(/^\/+/, '');
  if (!rest) return null;
  const [datasetName, ...subParts] = rest.split('/');
  return { datasetName, subPath: subParts.join('/') };
};

// Read a value out of the job config by the same dotted/bracketed path syntax the
// recipe buttons write with (mirrors setNestedValue in utils/hooks). Kept local to
// this fork-only component so upstream's hooks.tsx stays untouched.
const getAtPath = (obj: any, path: string): any => {
  const re = /([^[.\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  let current: any = obj;
  while ((m = re.exec(path)) !== null) {
    if (current == null) return undefined;
    current = current[m[1] !== undefined ? m[1] : Number(m[2])];
  }
  return current;
};

// Loose equality so 0.0001 (number) matches whatever the form holds, and a value the
// user hasn't set yet (undefined) never reads as "already applied".
const valuesEqual = (a: any, b: any): boolean => {
  if (a === undefined || a === null) return false;
  return String(a) === String(b);
};

const bandColor: Record<string, string> = {
  cool: 'text-sky-400',
  healthy: 'text-green-400',
  warm: 'text-orange-400',
  fry: 'text-red-400',
};

export default function StepSuggestion({ jobConfig, setJobConfig }: Props) {
  const { settings } = useSettings();
  const process = jobConfig.config.process[0];
  const datasets = process.datasets || [];
  const arch = process.model.arch;
  const batchSize = process.train.batch_size;
  const gradAccum = process.train.gradient_accumulation;
  const currentSteps = process.train.steps;

  const datasetInputs = useMemo(() => {
    return datasets
      .map(d => {
        const selection = deriveDatasetSelection(d.folder_path, settings.DATASETS_FOLDER);
        if (!selection) return null;
        const key = selection.subPath ? `${selection.datasetName}::${selection.subPath}` : selection.datasetName;
        return { key, datasetName: selection.datasetName, subPath: selection.subPath, numRepeats: d.num_repeats || 1 };
      })
      .filter((d): d is DatasetSelection => d !== null);
  }, [datasets, settings.DATASETS_FOLDER]);

  const datasetsKey = datasetInputs.map(d => d.key).join('|');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [analyses, setAnalyses] = useState<Record<string, DatasetAnalysis>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (datasetInputs.length === 0) {
      setCounts({});
      return;
    }
    Promise.all(
      datasetInputs.map(d => fetchCount(d.datasetName, d.subPath).then(count => [d.key, count] as const)),
    ).then(results => {
      if (cancelled) return;
      const next: Record<string, number> = {};
      for (const [key, count] of results) {
        next[key] = count;
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
      const count = counts[d.key];
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
      const analysis = await fetchAnalysis(d.datasetName, d.subPath);
      if (analysis) results[d.key] = analysis;
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
      const a = analyses[d.key];
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
        {currentSteps !== suggestion.suggested ? (
          <button
            type="button"
            className="ml-2 text-blue-400 hover:text-blue-300 underline"
            onClick={() => setJobConfig(suggestion.suggested, 'config.process[0].train.steps')}
          >
            Apply
          </button>
        ) : (
          <span className="ml-2 text-green-400">✓ set</span>
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
                {recipe.settings.map(s => {
                  const current = getAtPath(jobConfig, s.path);
                  const isSet = valuesEqual(current, s.value);
                  return (
                    <button
                      key={s.path}
                      type="button"
                      title={
                        isSet
                          ? `Already set to ${s.value}`
                          : current === undefined || current === null
                            ? `Set to ${s.value}`
                            : `Change from ${current} to ${s.value}`
                      }
                      className={
                        'mr-2 mb-1 px-2 py-0.5 rounded border ' +
                        (isSet
                          ? 'border-green-700 text-green-400 cursor-default'
                          : 'border-gray-600 text-blue-400 hover:text-blue-300 hover:border-gray-500')
                      }
                      onClick={() => setJobConfig(s.value, s.path)}
                    >
                      {isSet ? `✓ ${s.label}` : s.label}
                      {!isSet && current !== undefined && current !== null && (
                        <span className="text-gray-500"> (now {String(current)})</span>
                      )}
                    </button>
                  );
                })}
                {(() => {
                  const allSet = recipe.settings.every(s => valuesEqual(getAtPath(jobConfig, s.path), s.value));
                  return (
                    <button
                      type="button"
                      title={allSet ? 'All suggested settings are already applied' : 'Apply every suggested setting'}
                      className={
                        'mr-2 mb-1 px-2 py-0.5 rounded border ' +
                        (allSet
                          ? 'border-green-700 text-green-400 cursor-default'
                          : 'border-gray-600 text-blue-400 hover:text-blue-300 hover:border-gray-500')
                      }
                      onClick={() => {
                        for (const s of recipe.settings) setJobConfig(s.value, s.path);
                      }}
                    >
                      {allSet ? '✓ All applied' : 'Apply all'}
                    </button>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
