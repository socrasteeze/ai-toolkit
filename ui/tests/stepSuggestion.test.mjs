import assert from 'node:assert/strict';
import test from 'node:test';

import { weightedBatchSize } from '../src/utils/advisorBatch.ts';

test('weightedBatchSize reduces identical dataset batches to that batch size', () => {
  assert.equal(
    weightedBatchSize([
      { itemCount: 40, batchSize: 2 },
      { itemCount: 60, batchSize: 2 },
    ]),
    2,
  );
});

test('weightedBatchSize uses the microbatch-weighted mean for mixed dataset batches', () => {
  const value = weightedBatchSize([
    { itemCount: 100, batchSize: 1 },
    { itemCount: 100, batchSize: 2 },
  ]);
  assert.ok(Math.abs(value - 4 / 3) < 1e-12);
});

test('weightedBatchSize ignores empty datasets and falls back when no items are counted', () => {
  assert.equal(weightedBatchSize([{ itemCount: 0, batchSize: 8 }], 2), 2);
});

// --- effective batch ceiling (2026-08-24; see PLAN.md) -------------------------------
// The cap on effective batch was raised from a flat 2 to a size-dependent 4. These tests
// pin the property that made the flat cap necessary in the first place: the suggestion and
// exposureGauge() must never disagree about whether a config is in the fry band.

import {
  suggestSteps,
  exposureGauge,
  maxHealthyBatch,
  minItemsForBatch,
  getArchRecipe,
  getHeuristic,
  getHeuristicLookup,
  sizeTargetScale,
  SIZE_TARGET_ANCHOR_ITEMS,
} from '../src/utils/stepSuggestion.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CEILING_ARCHS = ['flux2_klein_4b', 'flux2_klein_9b', 'krea2', 'sdxl', 'anima'];

test('maxHealthyBatch holds effective batch at 2 on small datasets', () => {
  for (const arch of CEILING_ARCHS) {
    assert.equal(maxHealthyBatch(20, arch), 2, `${arch} at 20 files should cap at 2`);
  }
});

test('maxHealthyBatch allows effective batch 4 once the step floor stops binding', () => {
  for (const arch of CEILING_ARCHS) {
    assert.equal(maxHealthyBatch(150, arch), 4, `${arch} at 150 files should allow 4`);
  }
});

test('minItemsForBatch reports the file count each effective batch needs', () => {
  // Regression pins: batch 4 is not safe at the low end of a 20-150 image workflow.
  assert.equal(minItemsForBatch(4, 'flux2_klein_4b'), 40);
  assert.equal(minItemsForBatch(4, 'krea2'), 45);
  assert.equal(minItemsForBatch(4, 'anima'), 32);
  assert.equal(minItemsForBatch(4, 'sdxl'), 29);
  assert.equal(minItemsForBatch(1, 'anima'), 1);
});

test('suggestSteps flags an over-batched config and names the ceiling', () => {
  const result = suggestSteps({ itemCount: 25, arch: 'anima', batchSize: 4, gradientAccumulation: 1 });
  assert.equal(result.overBatched, true);
  assert.equal(result.batchCeiling, 2);
  assert.match(result.explanation, /highest effective batch that stays out of the fry band is 2/);
  assert.match(result.explanation, /needs ≥32 files/);
});

test('suggestSteps leaves a within-ceiling config unflagged', () => {
  const result = suggestSteps({ itemCount: 100, arch: 'anima', batchSize: 4, gradientAccumulation: 1 });
  assert.equal(result.overBatched, false);
  assert.equal(result.batchCeiling, 4);
  assert.doesNotMatch(result.explanation, /fry band/);
});

test('the overBatched flag never disagrees with exposureGauge', () => {
  // The 2026-07-29 bug was the suggestion recommending a step count its own gauge banded
  // fry-risk. Sweep the whole realistic space: every fry result must either be flagged as
  // over-batched, or be the irreducible case where even effective batch 1 overshoots
  // (≤9 images against a 600-1200 step floor) and there is no batch left to lower.
  for (const arch of [...CEILING_ARCHS, 'flux', 'chroma', 'qwen_image', undefined]) {
    for (let itemCount = 1; itemCount <= 400; itemCount += 1) {
      for (const batchSize of [1, 2, 4]) {
        const result = suggestSteps({ itemCount, arch, batchSize, gradientAccumulation: 1 });
        const gauge = exposureGauge({
          itemCount,
          arch,
          steps: result.suggested,
          batchSize,
          gradientAccumulation: 1,
        });
        if (gauge.band === 'fry' && !result.overBatched) {
          assert.equal(
            result.batchCeiling,
            1,
            `unflagged fry at arch=${arch} items=${itemCount} batch=${batchSize}`,
          );
          assert.equal(batchSize, 1, `unflagged fry above batch 1 at arch=${arch} items=${itemCount}`);
        }
        if (result.overBatched) {
          assert.equal(gauge.band, 'fry', `flagged non-fry at arch=${arch} items=${itemCount} batch=${batchSize}`);
        }
      }
    }
  }
});

test('gradient accumulation counts toward the ceiling the same as batch size', () => {
  const viaBatch = suggestSteps({ itemCount: 25, arch: 'anima', batchSize: 4, gradientAccumulation: 1 });
  const viaAccum = suggestSteps({ itemCount: 25, arch: 'anima', batchSize: 1, gradientAccumulation: 4 });
  assert.equal(viaBatch.suggested, viaAccum.suggested);
  assert.equal(viaBatch.overBatched, viaAccum.overBatched);
});

// --- provenance flags (2026-08-29) ------------------------------------------------------

test('a recipe reached by family prefix is flagged as inherited and unverified', () => {
  for (const [arch, base] of [
    ['flux2', 'flux'],
    ['flux_kontext', 'flux'],
    ['qwen_image_edit', 'qwen_image'],
    ['zimage_l2p', 'zimage'],
  ]) {
    const recipe = getArchRecipe(arch, 50);
    assert.equal(recipe.inheritedFrom, base, `${arch} should inherit from ${base}`);
    assert.match(recipe.notes, new RegExp(`^INHERITED FROM '${base}'`));
  }
});

test('an exact recipe key, an alias, or a :variant of one is NOT flagged', () => {
  for (const arch of ['flux', 'flex', 'chroma', 'flux2_klein_4b', 'zimage', 'zimage:turbo', 'krea2:turbo', 'anima']) {
    const recipe = getArchRecipe(arch, 50);
    assert.ok(recipe, `${arch} should have a recipe`);
    assert.equal(recipe.inheritedFrom, undefined, `${arch} must not be flagged`);
  }
});

test('the step heuristic reports whether it is arch-specific, inherited, or the generic default', () => {
  assert.equal(getHeuristicLookup('sdxl').source, 'arch');
  assert.equal(getHeuristicLookup('krea2:turbo').source, 'arch');
  assert.equal(getHeuristicLookup('wan22_14b_i2v').source, 'prefix');
  assert.equal(getHeuristicLookup('ideogram4').source, 'default');
  assert.equal(getHeuristicLookup('sd3').source, 'default'); // dead entry removed
  assert.match(suggestSteps({ itemCount: 40, arch: 'ideogram4', batchSize: 1, gradientAccumulation: 1 }).explanation, /generic default/);
  assert.match(suggestSteps({ itemCount: 40, arch: 'flux_kontext', batchSize: 1, gradientAccumulation: 1 }).explanation, /inherited from 'flux'/);
});

// --- ceiling-bound gauge (2026-08-29) ---------------------------------------------------

test('a large set at the arch ceiling reads cool but is marked ceiling-bound, not undertrained', () => {
  // 400 SDXL images × 100 steps/file = 40,000 raw; the 4000 ceiling binds and the advisor
  // suggests 4000. The gauge used to call that very number "likely undertrained".
  const result = suggestSteps({ itemCount: 400, arch: 'sdxl', batchSize: 1, gradientAccumulation: 1 });
  assert.equal(result.suggested, 4000);
  const gauge = exposureGauge({ itemCount: 400, arch: 'sdxl', steps: 4000, batchSize: 1, gradientAccumulation: 1 });
  assert.equal(gauge.band, 'cool');
  assert.equal(gauge.ceilingBound, true);
  assert.match(gauge.label, /ceiling binds/);
  assert.doesNotMatch(gauge.label, /undertrained/);
});

test('cool readings below the ceiling, or on sets the ceiling does not bind, stay plain cool', () => {
  // same set, user typed 2000 — genuinely below what the advisor would give
  const below = exposureGauge({ itemCount: 400, arch: 'sdxl', steps: 2000, batchSize: 1, gradientAccumulation: 1 });
  assert.equal(below.band, 'cool');
  assert.equal(below.ceilingBound, false);
  // small set, 4000 steps is way past target — not cool at all
  const small = exposureGauge({ itemCount: 20, arch: 'sdxl', steps: 500, batchSize: 1, gradientAccumulation: 1 });
  assert.equal(small.band, 'cool');
  assert.equal(small.ceilingBound, false);
  assert.match(small.label, /undertrained/);
});

test('ceilingBound never fires outside the cool band', () => {
  for (const arch of [...CEILING_ARCHS, 'flux', undefined]) {
    for (let itemCount = 1; itemCount <= 400; itemCount += 7) {
      for (const steps of [500, 1000, 2000, 3000, 4000, 6000]) {
        const gauge = exposureGauge({ itemCount, arch, steps, batchSize: 1, gradientAccumulation: 1 });
        if (gauge.ceilingBound) assert.equal(gauge.band, 'cool', `arch=${arch} items=${itemCount} steps=${steps}`);
      }
    }
  }
});

// --- dataset-size-aware exposure target (2026-08-29) ------------------------------------
// The flat per-arch target over-warned on large sets. The fix scales it down with dataset
// size using the one curve the repo has evidence for — krea2's measured/published triple.

test('the size scale only ever damps, and never below the anchor', () => {
  for (const n of [0, 1, 10, 30, 64, SIZE_TARGET_ANCHOR_ITEMS]) {
    assert.equal(sizeTargetScale(n), 1, `${n} items must not be scaled`);
  }
  // (65/130)^(1/3) = 0.5^(1/3); (65/520)^(1/3) = 0.125^(1/3) = 0.5
  assert.ok(Math.abs(sizeTargetScale(130) - 0.5 ** (1 / 3)) < 1e-12);
  assert.ok(Math.abs(sizeTargetScale(520) - 0.5) < 1e-12);
});

test('the size scale is monotonically decreasing and stays positive', () => {
  let previous = 1;
  for (let n = 1; n <= 4000; n += 7) {
    const scale = sizeTargetScale(n);
    assert.ok(scale > 0 && scale <= 1, `scale out of range at ${n}`);
    assert.ok(scale <= previous + 1e-12, `scale rose at ${n}`);
    previous = scale;
  }
});

test('the curve reproduces krea2’s own published large-set target (the corroboration)', () => {
  // krea2 medium = 32 steps/item, MEASURED on a documented 36-image run. Its large tier is
  // 20, from published 100-500 image recipes. Applying this curve to the measured anchor
  // must land on that published number — that is the whole evidence base for the shape.
  const predicted = 32 * sizeTargetScale(250);
  assert.ok(
    Math.abs(predicted - 20) < 1,
    `curve predicts ${predicted.toFixed(2)} steps/item at 250 images, krea2 publishes 20`,
  );
});

test('an arch with its own measured tiers is not scaled on top of them', () => {
  // krea2 defines a tier function; compounding would double-count the size effect.
  assert.equal(getHeuristic('krea2', 250).stepsPerItem, 20);
  assert.equal(getHeuristic('krea2', 1000).stepsPerItem, 20);
  assert.equal(getHeuristic('krea2:turbo', 250).stepsPerItem, 20);
});

test('no small or medium dataset advice moved', () => {
  // Everything at or below the anchor must be byte-identical to the pre-2026-08-29 numbers.
  for (const [arch, target] of [['sdxl', 100], ['flux', 60], ['anima', 75], ['qwen_image', 60]]) {
    for (const n of [1, 12, 29, 30, 64, 65]) {
      assert.equal(getHeuristic(arch, n).stepsPerItem, target, `${arch} at ${n} items moved`);
    }
  }
  assert.equal(getHeuristic('sdxl').stepsPerItem, 100); // no dataset yet
  // and the suggestion itself is unchanged on a small set
  assert.equal(suggestSteps({ itemCount: 20, arch: 'sdxl', batchSize: 1, gradientAccumulation: 1 }).suggested, 2000);
});

test('a large dataset gets a damped target, so the gauge stops over-warning', () => {
  const flat = getHeuristic('sdxl', 65).stepsPerItem;
  const scaled = getHeuristic('sdxl', 520).stepsPerItem;
  assert.equal(scaled, flat * 0.5);
  // same run, same steps: the reading moves toward healthy rather than staying deep-cool
  const before = 3000 / 250 / flat; // what the flat target would have banded
  const after = exposureGauge({
    itemCount: 250,
    arch: 'sdxl',
    steps: 3000,
    batchSize: 1,
    gradientAccumulation: 1,
  });
  assert.ok(after.exposures / getHeuristic('sdxl', 250).stepsPerItem > before);
});

test('the batch-4 file thresholds are unaffected (all below the anchor)', () => {
  // If the scale ever applied below the anchor these would drift, and presets/README.md
  // plus the ladder tests quote them.
  assert.equal(minItemsForBatch(4, 'sdxl'), 29);
  assert.equal(minItemsForBatch(4, 'anima'), 32);
  assert.equal(minItemsForBatch(4, 'flux2_klein_4b'), 40);
  assert.equal(minItemsForBatch(4, 'krea2'), 45);
  for (const n of [29, 32, 40, 45]) assert.equal(sizeTargetScale(n), 1);
});

// --- docs stay in step with the code ----------------------------------------------------

test('presets/README.md quotes the batch-4 file thresholds the code actually computes', () => {
  const readme = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'presets', 'README.md'), 'utf-8');
  // \s+ because the README hard-wraps mid-sentence
  const quoted = {
    sdxl: /≥(\d+)\s+files\s+on\s+SDXL\/Illustrious/.exec(readme)?.[1],
    anima: /≥(\d+)\s+on\s+Anima/.exec(readme)?.[1],
    flux2_klein_4b: /≥(\d+)\s+on\s+Klein/.exec(readme)?.[1],
    krea2: /≥(\d+)\s+on\s+Krea\s+2/.exec(readme)?.[1],
  };
  for (const [arch, value] of Object.entries(quoted)) {
    assert.ok(value, `README no longer quotes a threshold for ${arch}`);
    assert.equal(Number(value), minItemsForBatch(4, arch), `README threshold for ${arch} drifted from the code`);
  }
});
