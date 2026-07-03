// Fork-only file (see FORK_NOTES.md). Heuristics for suggesting a training step count from
// dataset size and model architecture. This trainer is strictly step-bounded (no
// kohya-style epochs/repeats), so this fills that gap with an advisory number.
//
// All values here are tunable starting points, not gospel — adjust after your own runs.

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
