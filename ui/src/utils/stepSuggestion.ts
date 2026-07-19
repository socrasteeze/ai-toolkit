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
  // Krea 2: community-derived, not a published author recipe. Modern flow-matching
  // backbone (flux-like), reported to hold identity faster than earlier models, so a
  // slightly lower exposure target than flux. Anchored on the small-dataset consensus
  // (~20-40 img: 600 steps = minimum viable likeness, ~2000 = the commonly-preferred
  // "safe" number). CAVEAT: like every fixed steps/item target here, this OVER-warns on
  // large datasets — published 100-500 img Krea2 recipes converge at only ~15-20 passes
  // per image, so a 250+ image set reading "cool" at 3000+ steps is usually already fine.
  // Trust the sample grids over the gauge once the dataset is large. See PLAN.md Phase 5.
  krea2: { stepsPerItem: 65, minSteps: 600, maxSteps: 4000 },
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
      batchSetting(4),
      schedulerSetting('cosine'),
    ],
    notes:
      'Vanilla SDXL: adamw8bit, cosine scheduler, batch 4 at 1024. ' +
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
      batchSetting(4),
      schedulerSetting('cosine'),
    ],
    notes: 'SD 1.5: adamw8bit, LR 1e-4, cosine, batch 4. Train at 512–768; 1024 buckets exceed what the base model does well.',
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
      'No source states an LR scheduler recommendation for this model; scheduler intentionally left unset (defaults to constant). ' +
      'Natural-language captions, describing only what should NOT be learned as a fixed trait (per Krea\'s own guidance). ' +
      'Turbo variants need the training adapter (set automatically when the arch is selected); keep low_vram on unless you have 48GB+. ' +
      'Alternative: Automagic v3 (self-adapting per-group LR, no scheduler needed) — used by the community 16GB config this ' +
      'fork ships as a preset. Its LR is a launch point the controller adapts away from (author\'s doc); if you use it, bound ' +
      'the controller with optimizer_params min_lr/max_lr (e.g. 1e-6/1e-4) — the bounds were added upstream 2026-07-17 ' +
      'specifically to prevent runaway edge cases. Low-confidence: the optimizer is ~6 weeks old with almost no arch-specific data. ' +
      'Timestep guidance (via LoRA Dataset Studio / RunComfy): linear timestep_type is the Krea-canonical choice.',
  }),
  zimage: tier => ({
    settings: [lrSetting(0.0001), rankSetting(tier === 'small' ? 16 : 32), alphaSetting(tier === 'small' ? 16 : 32), batchSetting(1)],
    notes:
      'Z-Image: adamw8bit, LR 1e-4, batch 1 at 1024. No arch-specific scheduler research found — left unset (defaults to constant). ' +
      'Timestep guidance (options.ts + Ostris subject guidance, via LoRA Dataset Studio): sigmoid for characters/subjects, weighted for style and concept training.',
  }),
  qwen_image: tier => ({
    settings: [lrSetting(0.0001), rankSetting(tier === 'small' ? 16 : 32), alphaSetting(tier === 'small' ? 16 : 32), batchSetting(1)],
    notes: 'Qwen-Image: adamw8bit, LR 1e-4, batch 1 at 1024. No arch-specific scheduler research found — left unset (defaults to constant).',
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
      'Timestep guidance (LoRA Dataset Studio, itself extrapolated/not Klein-verified): sigmoid for characters, weighted for style.',
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
      'Timestep guidance (LoRA Dataset Studio, itself extrapolated/not Klein-verified): sigmoid for characters, weighted for style.',
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
      rec('grad accum 4', 'config.process[0].train.gradient_accumulation', 4),
      schedulerSetting('constant'),
    ],
    notes:
      'Anima 2B: plain adamw (author\'s config), LR 2e-5 at rank 32, batch 1 with grad accumulation 4 — this is the ' +
      'model author\'s own recipe, the most authoritative of any arch here. Never train the LLM adapter (default off): ' +
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
        batchSetting(4),
        schedulerSetting('constant'),
      ],
      notes:
        'Illustrious-XL detected from checkpoint name: adamw8bit + constant LR is the more-cited combo ' +
        '(one camp explicitly reports Prodigy working poorly on Illustrious; the other camp still prefers Prodigy+cosine — genuinely contested, adamw8bit+constant chosen as the safer default). ' +
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

  if (arch in ARCH_RECIPES) return ARCH_RECIPES[arch](tier);
  for (const key of Object.keys(ARCH_RECIPES)) {
    if (arch.startsWith(key)) return ARCH_RECIPES[key](tier);
  }
  return null;
};
