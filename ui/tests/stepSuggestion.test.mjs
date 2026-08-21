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
