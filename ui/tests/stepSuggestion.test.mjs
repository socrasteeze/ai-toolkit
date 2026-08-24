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
} from '../src/utils/stepSuggestion.ts';

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
