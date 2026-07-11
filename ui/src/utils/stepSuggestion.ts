// Fork-only file (see FORK_NOTES.md). Heuristics for suggesting a training step count from
// dataset size and model architecture. This trainer is strictly step-bounded (no
// kohya-style epochs/repeats), so this fills that gap with an advisory number.
//
// All values here are tunable starting points, not gospel — adjust after your own runs.

import { getBucketForImageSize } from './buckets';

export interface StepHeuristic {
  // steps per training file at effective batch size 1
  stepsPerItem: number;
  minSteps: number;
  maxSteps: number;
}

const DEFAULT_HEURISTIC: StepHeuristic = { stepsPerItem: 75, minSteps: 1000, maxSteps: 3000 };

// Keyed by model.arch. Prefix matching handles variants (e.g. wan22_14b_i2v matches 'wan').
// 'sdxl' covers SDXL-family checkpoints like IllustriousXL and Pony.
const ARCH_HEURISTICS: Record<string, StepHeuristic> = {
  sdxl: { stepsPerItem: 100, minSteps: 1200, maxSteps: 4000 },
  sd15: { stepsPerItem: 100, minSteps: 1000, maxSteps: 3000 },
  sd3: { stepsPerItem: 80, minSteps: 1000, maxSteps: 3000 },
  flux: { stepsPerItem: 60, minSteps: 1000, maxSteps: 3000 },
  flex: { stepsPerItem: 60, minSteps: 1000, maxSteps: 3000 },
  chroma: { stepsPerItem: 60, minSteps: 1000, maxSteps: 3000 },
  lumina2: { stepsPerItem: 75, minSteps: 1000, maxSteps: 3000 },
  qwen_image: { stepsPerItem: 60, minSteps: 1000, maxSteps: 3000 },
  hidream: { stepsPerItem: 60, minSteps: 1000, maxSteps: 3000 },
  wan: { stepsPerItem: 100, minSteps: 1000, maxSteps: 4000 },
};

export const getHeuristic = (arch: string | undefined | null): StepHeuristic => {
  if (!arch) return DEFAULT_HEURISTIC;
  if (arch in ARCH_HEURISTICS) return ARCH_HEURISTICS[arch];
  for (const key of Object.keys(ARCH_HEURISTICS)) {
    if (arch.startsWith(key)) return ARCH_HEURISTICS[key];
  }
  return DEFAULT_HEURISTIC;
};

export interface StepSuggestionInput {
  // total training files across selected datasets, with each dataset's num_repeats applied
  itemCount: number;
  arch: string | undefined | null;
  batchSize: number;
  gradientAccumulation: number;
}

export interface StepSuggestionResult {
  suggested: number;
  low: number;
  high: number;
  // how many passes over the dataset the suggestion equals (the familiar mental model
  // from epoch-based trainers)
  epochsEquivalent: number;
  explanation: string;
}

const roundTo50 = (n: number) => Math.max(50, Math.round(n / 50) * 50);

export const suggestSteps = (input: StepSuggestionInput): StepSuggestionResult | null => {
  const { itemCount, arch } = input;
  if (!itemCount || itemCount <= 0) return null;
  const batchSize = Math.max(1, input.batchSize || 1);
  const gradAccum = Math.max(1, input.gradientAccumulation || 1);
  const effectiveBatch = batchSize * gradAccum;
  const heuristic = getHeuristic(arch);

  const clamp = (n: number) => Math.min(heuristic.maxSteps, Math.max(heuristic.minSteps, n));
  const raw = (itemCount * heuristic.stepsPerItem) / effectiveBatch;
  const suggested = roundTo50(clamp(raw));
  const low = roundTo50(clamp(raw * 0.7));
  const high = roundTo50(clamp(raw * 1.3));
  const epochsEquivalent = Math.round(((suggested * effectiveBatch) / itemCount) * 10) / 10;

  const explanation =
    `${itemCount} files × ${heuristic.stepsPerItem} steps/file ÷ effective batch ${effectiveBatch}` +
    ` = ${Math.round(raw)}, clamped to ${heuristic.minSteps}–${heuristic.maxSteps} for ${arch || 'this model'}.` +
    ` Each file is seen ≈${epochsEquivalent}× at the suggested count.`;

  return { suggested, low, high, epochsEquivalent, explanation };
};

// ==========================================================================
// Phase 2 additions (see PLAN.md): exposure gauge, bucket analysis, and
// per-arch recommended settings — ported from Anima-TrainFlow and generalized
// across ai-toolkit's model archs.
// ==========================================================================

export type ExposureBand = 'cool' | 'healthy' | 'warm' | 'fry';

export interface ExposureGauge {
  exposures: number; // steps × effective batch ÷ items — passes over each image
  band: ExposureBand;
  label: string;
}

// Bands are relative to the arch's stepsPerItem heuristic: healthy ≈ 0.7–1.3× of it,
// warm to 1.7×, fry-risk beyond (the Anima-TrainFlow bands, made arch-relative).
export const exposureGauge = (input: {
  itemCount: number;
  arch: string | undefined | null;
  steps: number;
  batchSize: number;
  gradientAccumulation: number;
}): ExposureGauge | null => {
  const { itemCount, arch, steps } = input;
  if (!itemCount || itemCount <= 0 || !steps || steps <= 0) return null;
  const effectiveBatch = Math.max(1, input.batchSize || 1) * Math.max(1, input.gradientAccumulation || 1);
  const target = getHeuristic(arch).stepsPerItem;
  const exposures = (steps * effectiveBatch) / itemCount;
  const ratio = exposures / target;
  let band: ExposureBand;
  if (ratio < 0.7) band = 'cool';
  else if (ratio <= 1.3) band = 'healthy';
  else if (ratio <= 1.7) band = 'warm';
  else band = 'fry';
  const labels: Record<ExposureBand, string> = {
    cool: '❄️ Cool — likely undertrained',
    healthy: '✅ Healthy',
    warm: '🔥 Warm — watch for overfit',
    fry: '💀 Fry-risk — likely overtrained',
  };
  return {
    exposures: Math.round(exposures * 10) / 10,
    band,
    label: labels[band],
  };
};

export interface BucketInfo {
  width: number;
  height: number;
  count: number;
}

export interface BucketAnalysis {
  resolution: number;
  buckets: BucketInfo[];
  // buckets with fewer images than the batch size (silently undertrained ratios)
  thin: BucketInfo[];
  // images whose source is smaller than the bucket they land in (will be upscaled)
  upscaled: number;
}

// dimensionCounts is the "WxH" → count histogram from /api/datasets/analyze.
// Mirrors toolkit/dataloader_mixins.py setup_buckets: one bucket set per training
// resolution, divisibility = bucket_tolerance (default 64).
export const analyzeBuckets = (
  dimensionCounts: Record<string, number>,
  resolution: number,
  batchSize: number,
  bucketTolerance: number = 64,
): BucketAnalysis => {
  const bucketMap = new Map<string, BucketInfo>();
  let upscaled = 0;
  for (const [dims, count] of Object.entries(dimensionCounts)) {
    const [w, h] = dims.split('x').map(Number);
    if (!w || !h) continue;
    const bucket = getBucketForImageSize(w, h, resolution, bucketTolerance);
    const key = `${bucket.width}x${bucket.height}`;
    const existing = bucketMap.get(key);
    if (existing) existing.count += count;
    else bucketMap.set(key, { width: bucket.width, height: bucket.height, count });
    if (w < bucket.width || h < bucket.height) upscaled += count;
  }
  const buckets = [...bucketMap.values()].sort((a, b) => b.count - a.count);
  const thin = batchSize > 1 ? buckets.filter(b => b.count < batchSize) : [];
  return { resolution, buckets, thin, upscaled };
};

// Which of the selected training resolutions the source images can actually fill:
// flags a resolution when most images would need upscaling to reach it.
export const resolutionAdvice = (
  dimensionCounts: Record<string, number>,
  resolutions: number[],
): string | null => {
  const entries = Object.entries(dimensionCounts);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const weak: string[] = [];
  for (const res of resolutions) {
    const maxPixels = res * res;
    let below = 0;
    for (const [dims, count] of entries) {
      const [w, h] = dims.split('x').map(Number);
      if (w * h < maxPixels) below += count;
    }
    if (below / total > 0.5) {
      weak.push(`${res} (${Math.round((below / total) * 100)}% of images smaller)`);
    }
  }
  if (weak.length === 0) return null;
  return `Most source images can't fill resolution ${weak.join(', ')} — they will be trained below it or upscaled. Consider unchecking it or sourcing larger images.`;
};

export interface ArchRecipe {
  // dot-path (under config.process[0]) → recommended value, applied via setJobConfig
  settings: { label: string; path: string; value: any }[];
  notes: string;
}

// Advisory starting points per arch family, prefix-matched like ARCH_HEURISTICS.
// Values are community-consensus starting points, not gospel (see PLAN.md table).
const ARCH_RECIPES: Record<string, ArchRecipe> = {
  sdxl: {
    settings: [
      { label: 'LR 1e-4', path: 'config.process[0].train.lr', value: 0.0001 },
      { label: 'rank 32', path: 'config.process[0].network.linear', value: 32 },
      { label: 'alpha 32', path: 'config.process[0].network.linear_alpha', value: 32 },
      { label: 'batch 4', path: 'config.process[0].train.batch_size', value: 4 },
    ],
    notes:
      'SDXL family (incl. IllustriousXL / Pony): adamw8bit, LR 1e-4, rank 32, batch 4 at 1024. ' +
      'For Illustrious/Pony use booru tag captions with a unique trigger tag first; drop LR to 5e-5 for small character sets.',
  },
  sd15: {
    settings: [
      { label: 'LR 1e-4', path: 'config.process[0].train.lr', value: 0.0001 },
      { label: 'rank 16', path: 'config.process[0].network.linear', value: 16 },
      { label: 'alpha 16', path: 'config.process[0].network.linear_alpha', value: 16 },
      { label: 'batch 4', path: 'config.process[0].train.batch_size', value: 4 },
    ],
    notes: 'SD 1.5: adamw8bit, LR 1e-4, rank 16, batch 4. Train at 512–768; 1024 buckets exceed what the base model does well.',
  },
  flux: {
    settings: [
      { label: 'LR 1e-4', path: 'config.process[0].train.lr', value: 0.0001 },
      { label: 'rank 32', path: 'config.process[0].network.linear', value: 32 },
      { label: 'alpha 32', path: 'config.process[0].network.linear_alpha', value: 32 },
      { label: 'batch 1', path: 'config.process[0].train.batch_size', value: 1 },
    ],
    notes: 'FLUX: adamw8bit, LR 1e-4, rank 16–32, batch 1 at 1024. Natural-language captions work better than tag lists.',
  },
  krea2: {
    settings: [
      { label: 'LR 1e-4', path: 'config.process[0].train.lr', value: 0.0001 },
      { label: 'rank 32', path: 'config.process[0].network.linear', value: 32 },
      { label: 'alpha 32', path: 'config.process[0].network.linear_alpha', value: 32 },
      { label: 'batch 1', path: 'config.process[0].train.batch_size', value: 1 },
    ],
    notes:
      'Krea 2: adamw8bit, LR 1e-4, rank 32, batch 1 at 1024. Turbo variants need the training adapter (set automatically when the arch is selected); keep low_vram on unless you have 48GB+.',
  },
  zimage: {
    settings: [
      { label: 'LR 1e-4', path: 'config.process[0].train.lr', value: 0.0001 },
      { label: 'rank 32', path: 'config.process[0].network.linear', value: 32 },
      { label: 'alpha 32', path: 'config.process[0].network.linear_alpha', value: 32 },
      { label: 'batch 1', path: 'config.process[0].train.batch_size', value: 1 },
    ],
    notes: 'Z-Image: adamw8bit, LR 1e-4, rank 32, batch 1 at 1024.',
  },
  qwen_image: {
    settings: [
      { label: 'LR 1e-4', path: 'config.process[0].train.lr', value: 0.0001 },
      { label: 'rank 32', path: 'config.process[0].network.linear', value: 32 },
      { label: 'alpha 32', path: 'config.process[0].network.linear_alpha', value: 32 },
      { label: 'batch 1', path: 'config.process[0].train.batch_size', value: 1 },
    ],
    notes: 'Qwen-Image: adamw8bit, LR 1e-4, rank 32, batch 1 at 1024.',
  },
};
ARCH_RECIPES.flex = ARCH_RECIPES.flux;
ARCH_RECIPES.chroma = ARCH_RECIPES.flux;

export const getArchRecipe = (arch: string | undefined | null): ArchRecipe | null => {
  if (!arch) return null;
  if (arch in ARCH_RECIPES) return ARCH_RECIPES[arch];
  for (const key of Object.keys(ARCH_RECIPES)) {
    if (arch.startsWith(key)) return ARCH_RECIPES[key];
  }
  return null;
};
