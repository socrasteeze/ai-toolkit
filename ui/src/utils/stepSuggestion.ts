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
// 'sdxl' covers SDXL-family checkpoints like IllustriousXL and Pony. A `:variant` suffix
// (zimage:turbo, krea2:turbo) is the same model with an adapter and resolves to its base
// key as an exact match, not a prefix match.
//
// An entry may be a flat StepHeuristic (the default — one exposure target for the arch) or a
// function of dataset-size tier, for archs where the right steps/item genuinely moves with
// dataset size. Only krea2 is tiered today; see its comment for why.
//
// (An `sd3` entry was removed 2026-08-29: the trainer has no SD3 arch, it matched nothing.)
const ARCH_HEURISTICS: Record<string, StepHeuristic | ((tier: SizeTier) => StepHeuristic)> = {
  sdxl: { stepsPerItem: 100, minSteps: 1200, maxSteps: 4000 },
  sd15: { stepsPerItem: 100, minSteps: 1000, maxSteps: 3000 },
  flux: { stepsPerItem: 60, minSteps: 1000, maxSteps: 3000 },
  flex: { stepsPerItem: 60, minSteps: 1000, maxSteps: 3000 },
  chroma: { stepsPerItem: 60, minSteps: 1000, maxSteps: 3000 },
  lumina2: { stepsPerItem: 75, minSteps: 1000, maxSteps: 3000 },
  qwen_image: { stepsPerItem: 60, minSteps: 1000, maxSteps: 3000 },
  hidream: { stepsPerItem: 60, minSteps: 1000, maxSteps: 3000 },
  wan: { stepsPerItem: 100, minSteps: 1000, maxSteps: 4000 },
  // Krea 2: community-derived, not a published author recipe. Modern flow-matching backbone
  // (flux-like), reported to hold identity faster than earlier models, so a lower exposure
  // target than flux. This is the one arch whose steps/item is TIERED (2026-07-29), because
  // two independent data points disagree by ~2x in a way a single number can't express:
  //   medium (32/img) — MEASURED. A documented 16GB run (36 images, batch 1, 1152 steps =
  //     32 passes/image) judged epoch 8 "solid", epoch 12 already over-idealized, and the
  //     final 32-pass checkpoint the most faithful. 36 x 32 reproduces that 1152 exactly.
  //     Caveat: that run was musubi-tuner, not this trainer — same rank 32 / alpha 32 /
  //     LR 1e-4 / adamw8bit recipe, but a different implementation.
  //   large (20/img) — the published 100-500 image Krea2 recipes converge at only ~15-20
  //     passes per image. This replaces the old flat 65, which made a 250+ image set read
  //     "cool" at 3000+ steps when it was usually already fine.
  //   small (45/img) — EXTRAPOLATION, not measurement: smaller sets need more passes each,
  //     so it sits above medium, but no run anchors it. Treat as the softest of the three.
  // Note the maxSteps ceiling (4000), not steps/item, is what still under-reports very large
  // sets — at 400 images the ceiling binds first. Trust sample grids over the gauge there.
  krea2: tier => ({
    stepsPerItem: tier === 'small' ? 45 : tier === 'medium' ? 32 : 20,
    minSteps: 600,
    maxSteps: 4000,
  }),
};

// `tier` only affects archs whose entry is tier-aware (currently just krea2). It defaults to
// 'medium' so the exported signature stays usable without a dataset size — callers that know
// the item count should pass getSizeTier(itemCount) so the suggestion and the exposure gauge
// resolve the SAME target. If those two ever diverge the gauge will contradict the number the
// advisor just recommended, which is exactly the failure the floor-warning below exists for.
const resolveHeuristic = (entry: StepHeuristic | ((tier: SizeTier) => StepHeuristic), tier: SizeTier): StepHeuristic =>
  typeof entry === 'function' ? entry(tier) : entry;

// How an arch found its entry in a keyed table: its own key (or its `:variant` base),
// a family prefix (wan22_14b_i2v -> wan, flux_kontext -> flux), or nothing at all.
export type LookupSource = 'arch' | 'prefix' | 'default';

export interface KeyedLookup<T> {
  value: T;
  source: LookupSource;
  // the table key that answered, when one did
  key?: string;
}

// Strip a `:variant` suffix — the trainer does the same (toolkit/config_modules.py).
export const baseArch = (arch: string): string => arch.split(':')[0];

const lookupByArch = <T>(table: Record<string, T>, arch: string | undefined | null, fallback: T): KeyedLookup<T> => {
  if (!arch) return { value: fallback, source: 'default' };
  if (arch in table) return { value: table[arch], source: 'arch', key: arch };
  const base = baseArch(arch);
  if (base in table) return { value: table[base], source: 'arch', key: base };
  for (const key of Object.keys(table)) {
    if (base.startsWith(key)) return { value: table[key], source: 'prefix', key };
  }
  return { value: fallback, source: 'default' };
};

export const getHeuristicLookup = (
  arch: string | undefined | null,
  tier: SizeTier = 'medium',
): KeyedLookup<StepHeuristic> => {
  const found = lookupByArch(ARCH_HEURISTICS, arch, DEFAULT_HEURISTIC);
  return { ...found, value: resolveHeuristic(found.value, tier) };
};

export const getHeuristic = (arch: string | undefined | null, tier: SizeTier = 'medium'): StepHeuristic =>
  getHeuristicLookup(arch, tier).value;

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
  // highest effective batch that keeps this dataset out of the fry band (1, 2 or 4)
  batchCeiling: number;
  // true when the requested effective batch is above that ceiling
  overBatched: boolean;
  // where the exposure target came from: this arch, a family prefix, or the generic default
  heuristicSource: LookupSource;
}

const roundTo50 = (n: number) => Math.max(50, Math.round(n / 50) * 50);
const formatBatchSize = (n: number) =>
  Number.isInteger(n) ? `${n}` : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');

// The effective batch sizes this fork actually ships settings for. 4 was banned outright
// until 2026-08-24; it is now allowed but only where the dataset is large enough that the
// minSteps floor doesn't bind (see maxHealthyBatch and PLAN.md's 2026-08-24 entry).
export const EFFECTIVE_BATCH_LADDER = [1, 2, 4] as const;

// Single source of truth for where the exposure bands start. exposureGauge() and
// maxHealthyBatch() both read it, so the gauge can never disagree with the batch ceiling
// the suggestion just recommended — that disagreement was the original 2026-07-29 bug.
const bandForRatio = (ratio: number): ExposureBand => {
  if (ratio < 0.7) return 'cool';
  if (ratio <= 1.3) return 'healthy';
  if (ratio <= 1.7) return 'warm';
  return 'fry';
};

// Real per-image exposure for a floor-clamped suggestion at this effective batch.
const exposureRatioAt = (itemCount: number, heuristic: StepHeuristic, effectiveBatch: number): number => {
  const raw = (itemCount * heuristic.stepsPerItem) / effectiveBatch;
  const steps = roundTo50(Math.min(heuristic.maxSteps, Math.max(heuristic.minSteps, raw)));
  return (steps * effectiveBatch) / itemCount / heuristic.stepsPerItem;
};

// Largest effective batch on the ladder whose suggestion still lands outside the fry band
// at this dataset size. Exposure is non-decreasing in effective batch (steps fall until the
// floor binds, then hold while the multiplier keeps growing), so the first fry result ends
// the search. This is the number that makes "batch 4 on the big machine" safe to act on:
// below the arch's floor-safe item count it returns 2 or 1 instead.
export const maxHealthyBatch = (itemCount: number, arch: string | undefined | null): number => {
  if (!itemCount || itemCount <= 0) return 1;
  const heuristic = getHeuristic(arch, getSizeTier(itemCount));
  let best: number = EFFECTIVE_BATCH_LADDER[0];
  for (const candidate of EFFECTIVE_BATCH_LADDER) {
    if (bandForRatio(exposureRatioAt(itemCount, heuristic, candidate)) === 'fry') break;
    best = candidate;
  }
  return best;
};

// Fewest files at which `effectiveBatch` stays out of the fry band, or null if it never
// does within a sane dataset size. Answers "how many images before I can use batch 4?".
export const minItemsForBatch = (effectiveBatch: number, arch: string | undefined | null): number | null => {
  if (effectiveBatch <= 1) return 1;
  for (let n = 1; n <= 2000; n += 1) {
    if (maxHealthyBatch(n, arch) >= effectiveBatch) return n;
  }
  return null;
};

export const suggestSteps = (input: StepSuggestionInput): StepSuggestionResult | null => {
  const { itemCount, arch } = input;
  if (!itemCount || itemCount <= 0) return null;
  const batchSize = Math.max(1, input.batchSize || 1);
  const gradAccum = Math.max(1, input.gradientAccumulation || 1);
  const effectiveBatch = batchSize * gradAccum;
  const lookup = getHeuristicLookup(arch, getSizeTier(itemCount));
  const heuristic = lookup.value;

  const clamp = (n: number) => Math.min(heuristic.maxSteps, Math.max(heuristic.minSteps, n));
  const raw = (itemCount * heuristic.stepsPerItem) / effectiveBatch;
  const suggested = roundTo50(clamp(raw));
  const low = roundTo50(clamp(raw * 0.7));
  const high = roundTo50(clamp(raw * 1.3));
  const epochsEquivalent = Math.round(((suggested * effectiveBatch) / itemCount) * 10) / 10;

  // Fork note: when raw falls under minSteps the floor raises the suggestion, which silently
  // multiplies real per-image exposure (steps × effective batch ÷ items) above the arch target —
  // the higher the effective batch, the worse it gets. That used to be invisible in the
  // explanation, so a floor-bound suggestion could read as authoritative while actually landing
  // in the exposure gauge's fry band. Say so instead, and point at the lever that fixes it.
  const flooredUp = raw < heuristic.minSteps;
  const effectiveBatchLabel = formatBatchSize(effectiveBatch);

  // Fork addition (2026-08-24): the floor warning above says "lower the effective batch"
  // but never said to what. Now that effective batch 4 is allowed on large enough sets,
  // vague advice isn't enough — name the ceiling for THIS dataset, and the file count the
  // requested batch would need. Same band thresholds as exposureGauge(), by construction.
  const batchCeiling = maxHealthyBatch(itemCount, arch);
  const overBatched = effectiveBatch > batchCeiling;
  const filesNeeded = overBatched ? minItemsForBatch(effectiveBatch, arch) : null;

  // Say where the target came from when it is not this arch's own number — a generic
  // 75/file for an arch nobody has researched must not read like a researched value.
  const provenance =
    lookup.source === 'default'
      ? ` (generic default — no ${arch || 'arch'}-specific exposure data)`
      : lookup.source === 'prefix'
        ? ` (target inherited from '${lookup.key}' — nothing ${arch}-specific researched)`
        : '';

  const explanation =
    `${itemCount} files × ${heuristic.stepsPerItem} steps/file ÷ effective batch ${effectiveBatchLabel}` +
    ` = ${Math.round(raw)}, clamped to ${heuristic.minSteps}–${heuristic.maxSteps} for ${arch || 'this model'}${provenance}.` +
    ` Each file is seen ≈${epochsEquivalent}× at the suggested count.` +
    (flooredUp
      ? ` Note: the ${heuristic.minSteps}-step floor raised this above the computed ${Math.round(raw)}, so exposure` +
        ` (≈${epochsEquivalent}×) runs above the ~${heuristic.stepsPerItem}× target for this arch — lower the effective` +
        ` batch (batch size × gradient accumulation, currently ${effectiveBatchLabel}) to bring the two back in line.`
      : '') +
    (overBatched
      ? ` At ${itemCount} files the highest effective batch that stays out of the fry band is ${batchCeiling}` +
        (filesNeeded ? `; effective batch ${effectiveBatchLabel} needs ≥${filesNeeded} files` : '') +
        '.'
      : '');

  return {
    suggested,
    low,
    high,
    epochsEquivalent,
    explanation,
    batchCeiling,
    overBatched,
    heuristicSource: lookup.source,
  };
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
  // true when the reading is 'cool' only because the arch's maxSteps ceiling binds at
  // this dataset size — i.e. the advisor's own suggestion cannot reach the target either
  ceilingBound: boolean;
}

// Bands are relative to the arch's stepsPerItem heuristic: healthy ≈ 0.7–1.3× of it,
// warm to 1.7×, fry-risk beyond (the Anima-TrainFlow bands, made arch-relative).
//
// Fork note (2026-08-29): the per-image target is a flat number per arch (only krea2 is
// tiered — see ARCH_HEURISTICS), so on a large dataset the maxSteps ceiling binds before
// the target is reached and the gauge read "cool — likely undertrained" against the very
// step count the advisor had just recommended. Large sets usually converge at fewer passes
// (that is why the ceiling exists), so that reading over-warned. The band is still 'cool'
// — the exposure really is below the flat target — but `ceilingBound` is set and the label
// says why, instead of asserting undertraining nobody measured. A per-arch tiered target
// would be the real fix; it needs a measured run per arch (PLAN.md, AIO.10).
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
  const heuristic = getHeuristic(arch, getSizeTier(itemCount));
  const target = heuristic.stepsPerItem;
  const exposures = (steps * effectiveBatch) / itemCount;
  const ratio = exposures / target;
  const band: ExposureBand = bandForRatio(ratio);
  const rawSteps = (itemCount * target) / effectiveBatch;
  const ceilingBound = band === 'cool' && rawSteps > heuristic.maxSteps && steps >= heuristic.maxSteps;
  const labels: Record<ExposureBand, string> = {
    cool: ceilingBound
      ? `❄️ Below the per-image target only because the ${heuristic.maxSteps}-step ceiling binds at this dataset size — large sets usually converge at fewer passes; trust sample grids over this gauge`
      : '❄️ Cool — likely undertrained',
    healthy: '✅ Healthy',
    warm: '🔥 Warm — watch for overfit',
    fry: '💀 Fry-risk — likely overtrained',
  };
  return {
    exposures: Math.round(exposures * 10) / 10,
    band,
    label: labels[band],
    ceilingBound,
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
export const resolutionAdvice = (dimensionCounts: Record<string, number>, resolutions: number[]): string | null => {
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
  // set when the recipe was found by family prefix (flux2 -> flux, qwen_image_edit ->
  // qwen_image, zimage_l2p -> zimage) rather than researched for this arch. The notes
  // already say so in-line; this is for callers that want to style it.
  inheritedFrom?: string;
}

// Dataset-size tiers used to scale rank/LR: small sets overfit fast at high rank/LR,
// large sets tolerate (and often need) more capacity. Thresholds are the same
// "<20 small, >150-200 large" bands cited across the researched community guides.
export type SizeTier = 'small' | 'medium' | 'large';

export const getSizeTier = (itemCount: number): SizeTier => {
  if (itemCount < 30) return 'small';
  if (itemCount < 150) return 'medium';
  return 'large';
};

const rec = (label: string, path: string, value: any) => ({ label, path, value });

const lrSetting = (value: number) => rec(`LR ${value}`, 'config.process[0].train.lr', value);
const rankSetting = (value: number) => rec(`rank ${value}`, 'config.process[0].network.linear', value);
const alphaSetting = (value: number) => rec(`alpha ${value}`, 'config.process[0].network.linear_alpha', value);
const batchSetting = (value: number) => rec(`batch ${value}`, 'config.process[0].train.batch_size', value);
// lr_scheduler has no UI field elsewhere and the trainer silently defaults to 'constant'
// (toolkit/config_modules.py) if never set — surfacing it here is the only place a user
// sees this knob at all.
const schedulerSetting = (value: string) => rec(`scheduler: ${value}`, 'config.process[0].train.lr_scheduler', value);

type RecipeByTier = (tier: SizeTier) => ArchRecipe;

// Advisory starting points per arch family. Values are community-consensus starting
// points synthesized from current guides (2025-2026), not gospel — see PLAN.md.
// Every recipe below scales rank/alpha/LR with dataset size; where research found no
// real consensus (e.g. scheduler for Krea 2 / Flux2), the notes say so explicitly
// instead of presenting a guess as settled.
const ARCH_RECIPES: Record<string, RecipeByTier> = {
  // Vanilla SDXL checkpoints only (not Illustrious/Pony — those are detected
  // separately via checkpoint name/path, see illustriousOrPonyRecipe below).
  sdxl: tier => ({
    settings: [
      lrSetting(tier === 'small' ? 0.00008 : 0.0001),
      rankSetting(tier === 'small' ? 16 : tier === 'medium' ? 32 : 64),
      alphaSetting(tier === 'small' ? 16 : tier === 'medium' ? 32 : 32),
      batchSetting(tier === 'large' ? 4 : 2),
      schedulerSetting('cosine'),
    ],
    notes:
      `Vanilla SDXL: adamw8bit, cosine scheduler, batch ${tier === 'large' ? 4 : 2} at 1024. ` +
      'Batch is tied to dataset size, not to the batch 4 many guides quote unconditionally: the step suggestion ' +
      'below divides by effective batch, and on a small set that quotient drops under the step floor and gets ' +
      'clamped back up — which silently doubles or triples exposure per image. Batch 4 is offered only on large ' +
      '(150+) sets where the floor no longer binds; the suggestion names the safe ceiling for your actual file ' +
      'count if you raise it further. ' +
      (tier === 'small'
        ? 'Small dataset (<30 images): lower rank (16) and LR (8e-5) to curb overfitting.'
        : tier === 'large'
          ? 'Large dataset (150+ images): rank can go to 64/alpha 32 without much overfit risk.'
          : 'Rank 32/alpha 32 is the common middle-ground for this dataset size.'),
  }),
  sd15: tier => ({
    settings: [
      lrSetting(0.0001),
      rankSetting(tier === 'small' ? 8 : 16),
      alphaSetting(tier === 'small' ? 8 : 16),
      batchSetting(2),
      schedulerSetting('cosine'),
    ],
    notes:
      'SD 1.5: adamw8bit, LR 1e-4, cosine, batch 2. Train at 512–768; 1024 buckets exceed what the base model does well. ' +
      'Batch 2 rather than the commonly-quoted 4 — on small datasets a high effective batch pushes the step suggestion ' +
      'under its floor, where clamping inflates real exposure per image well past the target.',
  }),
  flux: tier => ({
    settings: [
      lrSetting(0.0001),
      rankSetting(tier === 'small' ? 16 : 32),
      // 2025 refinement: alpha below rank (not alpha=rank) reduces "frying" on style LoRAs,
      // most cited for small/simple datasets — large datasets use the older alpha=rank default.
      alphaSetting(tier === 'large' ? 32 : 16),
      batchSetting(1),
      schedulerSetting('constant'),
    ],
    notes:
      'FLUX: adamw8bit, LR 1e-4, constant scheduler (not cosine — community consensus favors constant, ' +
      'optionally with ~10% warmup, for flow-matching Flux training). Natural-language captions work better than tag lists.',
  }),
  // Krea 2: thin evidence base (model is ~6 weeks old as of this writing) — every source
  // traces back to one musubi-tuner guide + one HF recipe doc, so treat these as low-confidence.
  krea2: tier => ({
    settings: [
      lrSetting(0.0001),
      rankSetting(tier === 'small' ? 16 : 32),
      alphaSetting(tier === 'small' ? 16 : 32),
      batchSetting(1),
    ],
    notes:
      'Krea 2: adamw8bit, LR 1e-4, rank 32, batch 1 at 1024 — thin community evidence, treat as a starting point only. ' +
      'A documented 16GB run (36 images, musubi-tuner, not this trainer) independently landed on this same rank 32 / ' +
      'alpha 32 / LR 1e-4 / adamw8bit combination, which is the strongest corroboration these numbers have. ' +
      'Train at 512 or 1024, not in between: match a resolution the base model was actually trained at. ' +
      'No source states an LR scheduler recommendation for this model; scheduler intentionally left unset (defaults to constant). ' +
      "Natural-language captions, describing only what should NOT be learned as a fixed trait (per Krea's own guidance). " +
      'TRIGGER BLEED (the LoRA showing up in prompts that omit the trigger) is normal LoRA behaviour, not primarily a ' +
      'caption defect — a LoRA shifts weights globally, it cannot scope itself to one token. The real levers in this ' +
      'trainer are Differential Output Preservation (train.diff_output_preservation, with _class set to e.g. "person") ' +
      'and regularization datasets (is_reg / reg_weight), plus a lower LR. Two constraints before enabling DOP: it ' +
      'REQUIRES a trigger_word (the trainer raises without one), and it is mutually exclusive with cache_text_embeddings ' +
      '(hard error), so it cannot be combined with the cache-embeds memory strategy — and it costs roughly a second ' +
      'forward pass per step, which matters on 16GB. Secondary and cheaper: keep invariant identity attributes out of ' +
      'captions (describe what varies — clothing, pose, framing, light — and let the trigger carry the face), since ' +
      'the identity can otherwise bind to a description you reuse in other prompts. That last point is a plausible ' +
      "hypothesis from the 16GB run's control grid, not a demonstrated fix — its author never re-ran to confirm it. " +
      'Turbo variants need the training adapter (set automatically when the arch is selected); keep low_vram on unless you have 48GB+. ' +
      'Alternative: Automagic v3 (self-adapting per-group LR, no scheduler needed) — used by the community 16GB config this ' +
      "fork ships as a preset. Its LR is a launch point the controller adapts away from (author's doc); if you use it, bound " +
      'the controller with optimizer_params min_lr/max_lr (e.g. 1e-6/1e-4) — the bounds were added upstream 2026-07-17 ' +
      'specifically to prevent runaway edge cases. Automagic fuses its step into the backward pass by default, so it requires ' +
      'gradient_accumulation (and the legacy gradient_accumulation_steps) at 1 — reach a larger effective batch by raising ' +
      'batch size instead, or set optimizer_params.fused: false to accumulate normally (config_modules.py hard-errors on the ' +
      'fused+accumulating combination). Low-confidence: the optimizer is ~6 weeks old with almost no arch-specific data. ' +
      'Timestep guidance (via LoRA Dataset Studio / RunComfy): linear timestep_type is the Krea-canonical choice.',
  }),
  zimage: tier => ({
    settings: [
      lrSetting(0.0001),
      rankSetting(tier === 'small' ? 16 : 32),
      alphaSetting(tier === 'small' ? 16 : 32),
      batchSetting(1),
    ],
    notes:
      'Z-Image: adamw8bit, LR 1e-4, batch 1 at 1024. No arch-specific scheduler research found — left unset (defaults to constant). ' +
      'Timestep guidance (options.ts + Ostris subject guidance, via LoRA Dataset Studio): sigmoid for characters/subjects, weighted for style and concept training.',
  }),
  qwen_image: tier => ({
    settings: [
      lrSetting(0.0001),
      rankSetting(tier === 'small' ? 16 : 32),
      alphaSetting(tier === 'small' ? 16 : 32),
      batchSetting(1),
    ],
    notes:
      'Qwen-Image: adamw8bit, LR 1e-4, batch 1 at 1024. No arch-specific scheduler research found — left unset (defaults to constant).',
  }),
  // FLUX.2 Klein: ai-toolkit has native support (arch keys flux2_klein_4b/9b) but almost no
  // FLUX.2-specific tuning literature exists yet — these numbers are the FLUX.1 consensus
  // recipe used as the best available proxy, flagged as such.
  flux2_klein_4b: tier => ({
    settings: [
      lrSetting(0.0001),
      rankSetting(tier === 'small' ? 16 : 32),
      alphaSetting(tier === 'large' ? 32 : 16),
      batchSetting(1),
      schedulerSetting('constant'),
    ],
    notes:
      'FLUX.2 Klein 4B: unverified — no FLUX.2-specific recipe exists yet, these are FLUX.1 community defaults used as a proxy. ' +
      'Needs ~32GB VRAM minimum (48GB practical) per early reports. Natural-language captions. ' +
      'A 50+-run community study (single-source, style-focused) found Flux-family training extremely LR-sensitive — ' +
      '"leave the learning rate alone" — with training dose (steps × batch × accum vs image count) the main lever, and ' +
      'weight decay mattering more than expected (their style runs preferred 1e-5 over the 1e-4 default). ' +
      'Timestep guidance (LoRA Dataset Studio, itself extrapolated/not Klein-verified): sigmoid for characters, weighted for style. ' +
      "STYLE-specific network (that same sweep + BFL's official Klein example): a linear+Conv2d LoRA at ratio 4:2:2:1 — LDS ships 128/64/64/32; the flux2_klein_style_lora.json preset folds that to a half-scale 64/32 linear + 32/16 conv (128 judged too heavy for a 4B). This ramp is linear-only; use the style preset for the conv recipe.",
  }),
  flux2_klein_9b: tier => ({
    settings: [
      lrSetting(0.0001),
      rankSetting(tier === 'small' ? 16 : 32),
      alphaSetting(tier === 'large' ? 32 : 16),
      batchSetting(1),
      schedulerSetting('constant'),
    ],
    notes:
      'FLUX.2 Klein 9B: unverified — no FLUX.2-specific recipe exists yet, these are FLUX.1 community defaults used as a proxy. ' +
      'Needs more VRAM than the 4B variant; 48GB is a practical minimum. Natural-language captions. ' +
      'A 50+-run community study (single-source, style-focused) found Flux-family training extremely LR-sensitive — ' +
      '"leave the learning rate alone" — with training dose (steps × batch × accum vs image count) the main lever, and ' +
      'weight decay mattering more than expected (their style runs preferred 1e-5 over the 1e-4 default). ' +
      'Timestep guidance (LoRA Dataset Studio, itself extrapolated/not Klein-verified): sigmoid for characters, weighted for style. ' +
      "STYLE-specific network (that same sweep + BFL's official Klein example): a linear+Conv2d LoRA at ratio 4:2:2:1 — LDS ships 128/64/64/32; the flux2_klein_style_lora.json preset folds that to a half-scale 64/32 linear + 32/16 conv (128 judged too heavy for a 4B). This ramp is linear-only; use the style preset for the conv recipe.",
  }),
  // Anima 2B (native upstream arch since ostris#860): unusually well-sourced — the numbers below are the model
  // author's own published recipe (Circlestone Labs finetuning tips + his diffusion-pipe
  // example config), not community guesswork. See docs/anima_delta_catalog.md §9.
  anima: tier => ({
    settings: [
      // author: "for a rank 32 LoRA, start with 2e-5 and adjust" — scaled down for tiny sets
      lrSetting(tier === 'small' ? 0.000015 : 0.00002),
      rankSetting(tier === 'small' ? 16 : 32),
      alphaSetting(tier === 'small' ? 16 : 32),
      batchSetting(1),
      rec(
        `grad accum ${tier === 'large' ? 4 : 2}`,
        'config.process[0].train.gradient_accumulation',
        tier === 'large' ? 4 : 2,
      ),
      schedulerSetting('constant'),
    ],
    notes:
      "Anima 2B: plain adamw (author's config), LR 2e-5 at rank 32 — the model author's own recipe, the most " +
      'authoritative of any arch here. ' +
      (tier === 'large'
        ? "Effective batch 4 here matches the author's published recipe exactly (batch 1 + grad accumulation 4); " +
          'at 150+ files the step floor no longer binds, so that batch no longer inflates exposure. '
        : 'FORK DEVIATION ON THIS DATASET SIZE: the author pairs this with batch 1 + grad accumulation 4 ' +
          '(effective batch 4); below 150 files this fork suggests accumulation 2 instead, because at effective ' +
          'batch 4 the step suggestion drops under its floor and gets clamped up, inflating real exposure per ' +
          'image 2-3x past target. The suggestion names the safe ceiling for your actual file count. ') +
      'Rank/alpha/LR/optimizer are untouched author values. ' +
      'NOTE: if you switch the optimizer to automagic3, grad accumulation must be 1 unless you also set ' +
      'optimizer_params.fused=false — fused Automagic steps every micro-batch (config-parse error otherwise). ' +
      'Never train the LLM adapter (default off): ' +
      'it shapes all text conditioning and degrades easily. Anima is a base model with no aesthetic tuning to overcome — ' +
      '"a light touch is all you need". Danbooru-style tag captions work well (anime-focused base).',
  }),
};
ARCH_RECIPES.flex = ARCH_RECIPES.flux;
ARCH_RECIPES.chroma = ARCH_RECIPES.flux;

// Illustrious-XL and Pony Diffusion are SDXL-architecture checkpoints (model.arch is just
// "sdxl" for both — the trainer has no separate arch key for them), so the only way to tell
// them apart from vanilla SDXL is the checkpoint name/path the user picked.
const illustriousOrPonyRecipe = (modelPath: string, tier: SizeTier): ArchRecipe | null => {
  const p = modelPath.toLowerCase();
  if (p.includes('illustrious')) {
    return {
      settings: [
        lrSetting(tier === 'small' ? 0.0002 : 0.0003),
        rankSetting(tier === 'small' ? 32 : 64),
        alphaSetting(tier === 'small' ? 16 : 32),
        batchSetting(tier === 'large' ? 4 : 2),
        schedulerSetting('constant'),
      ],
      notes:
        'Illustrious-XL detected from checkpoint name: adamw8bit + constant LR is the more-cited combo ' +
        '(one camp explicitly reports Prodigy working poorly on Illustrious; the other camp still prefers Prodigy+cosine — genuinely contested, adamw8bit+constant chosen as the safer default). ' +
        `Batch ${tier === 'large' ? 4 : 2}: the batch 4 the guides quote is only safe once the set is large ` +
        'enough that the step floor stops binding — below 150 files the suggestion falls under its floor at ' +
        'effective batch 4 and gets clamped up, inflating real per-image exposure into fry range. ' +
        'Booru/danbooru-tag captions (WD14-tagger style), not natural language — Illustrious was trained on tagged data.',
    };
  }
  if (p.includes('pony')) {
    return {
      settings: [
        lrSetting(tier === 'small' ? 0.0001 : 0.0003),
        rankSetting(tier === 'small' ? 16 : 32),
        alphaSetting(tier === 'small' ? 8 : 16),
        batchSetting(2),
        schedulerSetting('cosine'),
      ],
      notes:
        'Pony Diffusion V6 detected from checkpoint name: adamw8bit, cosine (or cosine_with_restarts), rank 32/alpha 16 is the most-repeated ' +
        'convention though real spread exists across guides. Booru/e621-tag captions. ' +
        'score_9/score_8_up quality tags are contested for training captions (some guides fix one in every caption, others omit entirely) — ' +
        "don't add score_9 if your training images are mixed/lower quality, it can destabilize the LoRA; use score_8_up or lower instead.",
    };
  }
  return null;
};

export const getArchRecipe = (
  arch: string | undefined | null,
  itemCount: number = 0,
  modelPath: string = '',
): ArchRecipe | null => {
  if (!arch) return null;
  const tier = getSizeTier(itemCount);

  if (arch === 'sdxl' || arch.startsWith('sdxl')) {
    const special = illustriousOrPonyRecipe(modelPath, tier);
    if (special) return special;
  }

  const found = lookupByArch<RecipeByTier | null>(ARCH_RECIPES, arch, null);
  if (!found.value) return null;
  const recipe = found.value(tier);
  if (found.source !== 'prefix') return recipe;

  // Fork note (2026-08-29): a prefix hit used to return the base family's recipe and
  // notes verbatim, so FLUX.2 dev showed FLUX.1 numbers with no caveat while its Klein
  // siblings (exact keys) were flagged UNVERIFIED. Same honesty rule for both.
  return {
    ...recipe,
    inheritedFrom: found.key,
    notes:
      `INHERITED FROM '${found.key}': nothing ${arch}-specific was researched — every number below is the ` +
      `${found.key} recipe applied to a different model and is unverified for it. ` +
      recipe.notes,
  };
};
