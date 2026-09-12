// Fork-only file (see FORK_NOTES.md). Machine-aware batch plan for the step advisor
// (2026-09-11). The advisor was VRAM-unaware by design: it knew the largest effective batch
// a DATASET tolerates (maxHealthyBatch, the fry-band gate) but nothing about whether the
// card could run it, and it left the batch_size-vs-gradient_accumulation choice to the user.
// This file adds the machine side and picks the route, so one Apply can set batch_size,
// gradient_accumulation and steps together — 3000 steps at batch 1 and 3000 at batch 4 are
// different runs, and the suggestion has to move all three at once.
//
// Premise, and its limit: inside the [1, 2, 4] ladder, effective batch mostly trades speed
// for VRAM and the LoRA guides do not rescale LR, so "if it fits, run it" holds — subject to
// the dataset gate. Past 4 the LR would need to drop (the Klein general-FT recipe pairs batch
// 4 with LR 1e-5), which is one reason the ladder stops there.
//
// The VRAM table is the OPERATOR'S OWN MEASUREMENTS on the two machines this fork targets,
// recorded 2026-09-11. Every cell says whether it was measured or inferred. The 24 GB tier
// has no measurements at all and reuses the 16 GB numbers as a floor — replace those cells
// the first time a 24 GB card runs anything.

import { maxHealthyBatch } from './stepSuggestion';

export type MachineTier = 'laptop16' | 'mid24' | 'desktop32';

export const TIER_LABEL: Record<MachineTier, string> = {
  laptop16: '16 GB laptop',
  mid24: '24 GB',
  desktop32: '32 GB+ desktop',
};

// nvidia-smi reports memory.total in MiB. A 16 GB laptop 5080 reads ~16.3k, a 24 GB 4090
// ~24.5k, a 32 GB 5090 ~32.6k. Thresholds sit between the classes, not on them.
export const tierForVramMb = (totalMb: number | null | undefined): MachineTier | null => {
  if (!totalMb || !Number.isFinite(totalMb) || totalMb <= 0) return null;
  if (totalMb <= 18_000) return 'laptop16';
  if (totalMb <= 28_000) return 'mid24';
  return 'desktop32';
};

export interface VramCell {
  // largest batch_size (one micro-batch resident) that fit; 0 = OOM even at batch 1
  maxMicroBatch: number;
  measured: boolean;
  note: string;
}

// Keyed by arch family. Lookup is exact on the base arch (krea2:turbo -> krea2), then by
// the longest family key that prefixes it (flux2_klein_9b -> flux2_klein, illustrious
// checkpoints report arch "sdxl" already).
const M = (maxMicroBatch: number, note: string): VramCell => ({ maxMicroBatch, measured: true, note });
const I = (maxMicroBatch: number, note: string): VramCell => ({ maxMicroBatch, measured: false, note });

const DESKTOP32: Record<string, VramCell> = {
  sdxl: M(4, 'batch 1, 2 and 4 all ran on the 32 GB desktop'),
  anima: M(4, 'batch 1, 2 and 4 all ran on the 32 GB desktop'),
  flux2_klein: M(2, 'batch 1 and 2 ran on the 32 GB desktop; 4 not yet tried'),
  krea2: M(2, 'batch 1 and 2 ran on the 32 GB desktop; 4 not yet tried'),
};

const LAPTOP16: Record<string, VramCell> = {
  sdxl: M(2, 'batch 1 and 2 ran on the 16 GB laptop (Illustrious); 4 not yet tried'),
  anima: M(2, 'batch 1 and 2 ran on the 16 GB laptop; 4 not yet tried'),
  krea2: M(1, 'batch 1 ran on the 16 GB laptop; batch 2 did not'),
  flux2_klein: M(0, 'OOM on the 16 GB laptop (Klein variant not recorded — treat 4B and 9B alike until measured)'),
};

// No 24 GB card has run anything in this fork. Reuse the 16 GB measurements as a floor —
// guaranteed to fit, probably conservative — and say so on every cell.
const MID24: Record<string, VramCell> = Object.fromEntries(
  Object.entries(LAPTOP16).map(([k, v]) => [
    k,
    I(v.maxMicroBatch, `no 24 GB measurements; reusing the 16 GB result as a floor (${v.note})`),
  ]),
);

const DEFAULT_CELL: Record<MachineTier, VramCell> = {
  desktop32: I(1, 'no measurement for this arch on the 32 GB desktop; batch 1 assumed to fit'),
  mid24: I(1, 'no measurement for this arch on a 24 GB card; batch 1 assumed to fit'),
  laptop16: I(1, 'no measurement for this arch on the 16 GB laptop; batch 1 assumed to fit'),
};

export const VRAM_TABLE: Record<MachineTier, Record<string, VramCell>> = {
  desktop32: DESKTOP32,
  mid24: MID24,
  laptop16: LAPTOP16,
};

const familyFor = (arch: string, table: Record<string, VramCell>): string | null => {
  const base = arch.split(':')[0];
  if (table[base]) return base;
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    if (base.startsWith(key) && (best === null || key.length > best.length)) best = key;
  }
  return best;
};

export const vramCellFor = (tier: MachineTier, arch: string | null | undefined): VramCell => {
  if (!arch) return DEFAULT_CELL[tier];
  const table = VRAM_TABLE[tier];
  const family = familyFor(arch, table);
  return family ? table[family] : DEFAULT_CELL[tier];
};

export interface BatchPlanInput {
  itemCount: number;
  arch: string | null | undefined;
  tier: MachineTier;
  optimizer?: string | null;
  // optimizer_params.fused; Automagic defaults to fused, v1/v2 have no unfused mode
  fused?: boolean | null;
}

export interface BatchPlan {
  // false when the arch OOMs at batch 1 on this machine; the rest is then a placeholder
  fits: boolean;
  batchSize: number;
  gradAccum: number;
  effective: number;
  route: 'batch' | 'accum' | 'none';
  // the two ceilings the plan is the minimum of
  datasetCeiling: number;
  vramCeiling: number;
  // true only when the binding VRAM cell was measured on real hardware
  measured: boolean;
  vramNote: string;
  reasons: string[];
}

// Rule set, in the order it is applied:
//  1. The dataset gate wins: effective batch never exceeds maxHealthyBatch (the fry band).
//  2. A 32 GB desktop reaches effective batch with batch_size (one kernel pass, no per-
//     micro-batch cache flush). 16 GB and 24 GB reach it with gradient_accumulation, which
//     keeps one micro-batch of activations resident and so is capped only by the dataset.
//  3. Fused Automagic cannot accumulate (config_modules.py hard-errors), so it takes the
//     batch_size route on every tier — on a card where batch 2 does not fit, that means
//     effective batch 1, said out loud.
//  4. batch_size is capped by the VRAM cell; where that cell is below the dataset ceiling
//     the plan says which one bound it, and whether the cell was measured.
export const suggestBatch = (input: BatchPlanInput): BatchPlan => {
  const itemCount = Math.max(0, input.itemCount || 0);
  const datasetCeiling = maxHealthyBatch(itemCount, input.arch);
  const cell = vramCellFor(input.tier, input.arch);
  const vramCeiling = cell.maxMicroBatch;
  const reasons: string[] = [];

  if (vramCeiling <= 0) {
    return {
      fits: false,
      batchSize: 1,
      gradAccum: 1,
      effective: 1,
      route: 'none',
      datasetCeiling,
      vramCeiling,
      measured: cell.measured,
      vramNote: cell.note,
      reasons: [`${input.arch ?? 'this arch'} does not fit on a ${TIER_LABEL[input.tier]} even at batch 1 — ${cell.note}.`],
    };
  }

  const opt = (input.optimizer || '').toLowerCase();
  const fusedAutomagic = opt.startsWith('automagic') && input.fused !== false;
  const batchRoute = input.tier === 'desktop32' || fusedAutomagic;

  reasons.push(
    `dataset allows effective batch ${datasetCeiling} at ${itemCount} files (fry-band gate)`,
    `${TIER_LABEL[input.tier]}: batch_size up to ${vramCeiling} ${cell.measured ? 'measured' : 'inferred'} for ${input.arch ?? 'this arch'}`,
  );

  let batchSize: number;
  let gradAccum: number;
  if (batchRoute) {
    batchSize = Math.min(datasetCeiling, vramCeiling);
    gradAccum = 1;
    if (fusedAutomagic && input.tier !== 'desktop32') {
      reasons.push('fused Automagic cannot accumulate, so batch_size is the only route on this card');
    }
    if (batchSize < datasetCeiling) {
      reasons.push(
        fusedAutomagic
          ? `effective batch held at ${batchSize} by VRAM: accumulation is unavailable under fused Automagic (optimizer_params.fused: false would allow it, at the cost of fused's low peak VRAM)`
          : `VRAM-capped at ${batchSize}, below the dataset's ${datasetCeiling} — ${cell.note}`,
      );
    } else {
      reasons.push('reached with batch_size: one kernel pass, no per-micro-batch cache flush');
    }
  } else {
    batchSize = 1;
    gradAccum = datasetCeiling;
    reasons.push(
      gradAccum > 1
        ? `reached with gradient_accumulation ${gradAccum} at batch 1: one micro-batch of activations resident, so VRAM does not bind (costs a cuda empty_cache() per micro-batch under low_vram)`
        : 'effective batch 1: the dataset is too small for more',
    );
  }

  return {
    fits: true,
    batchSize,
    gradAccum,
    effective: batchSize * gradAccum,
    route: batchRoute ? 'batch' : 'accum',
    datasetCeiling,
    vramCeiling,
    measured: cell.measured,
    vramNote: cell.note,
    reasons,
  };
};
