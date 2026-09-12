import assert from 'node:assert/strict';
import test from 'node:test';

import { suggestBatch, tierForVramMb, vramCellFor, VRAM_TABLE } from '../src/utils/batchAdvisor.ts';
import { maxHealthyBatch, EFFECTIVE_BATCH_LADDER } from '../src/utils/stepSuggestion.ts';

// --- machine tier from live nvidia-smi memory.total (MiB) ---------------------------------

test('tierForVramMb classes the three cards this fork targets and rejects junk', () => {
  assert.equal(tierForVramMb(16303), 'laptop16'); // RTX 5080 Laptop
  assert.equal(tierForVramMb(24564), 'mid24'); // RTX 4090
  assert.equal(tierForVramMb(32607), 'desktop32'); // RTX 5090
  assert.equal(tierForVramMb(0), null);
  assert.equal(tierForVramMb(null), null);
  assert.equal(tierForVramMb(NaN), null);
});

// --- the measured VRAM table (operator's runs, 2026-09-11) --------------------------------

test('desktop measurements: SDXL and Anima ran batch 4, Klein and Krea 2 ran batch 2', () => {
  for (const arch of ['sdxl', 'anima']) {
    const c = vramCellFor('desktop32', arch);
    assert.equal(c.maxMicroBatch, 4, arch);
    assert.equal(c.measured, true, arch);
  }
  for (const arch of ['flux2_klein_4b', 'flux2_klein_9b', 'krea2', 'krea2:turbo']) {
    const c = vramCellFor('desktop32', arch);
    assert.equal(c.maxMicroBatch, 2, arch);
    assert.equal(c.measured, true, arch);
    assert.match(c.note, /not yet tried/);
  }
});

test('laptop measurements: Klein OOMs, Krea 2 fits only batch 1, SDXL and Anima fit batch 2', () => {
  assert.equal(vramCellFor('laptop16', 'flux2_klein_4b').maxMicroBatch, 0);
  assert.equal(vramCellFor('laptop16', 'flux2_klein_9b').maxMicroBatch, 0);
  assert.equal(vramCellFor('laptop16', 'krea2').maxMicroBatch, 1);
  assert.equal(vramCellFor('laptop16', 'sdxl').maxMicroBatch, 2);
  assert.equal(vramCellFor('laptop16', 'anima').maxMicroBatch, 2);
  for (const arch of ['flux2_klein_4b', 'krea2', 'sdxl', 'anima']) {
    assert.equal(vramCellFor('laptop16', arch).measured, true, arch);
  }
});

test('the 24 GB tier has no measurements and says so on every cell', () => {
  for (const [arch, cell] of Object.entries(VRAM_TABLE.mid24)) {
    assert.equal(cell.measured, false, arch);
    assert.match(cell.note, /no 24 GB measurements/);
    assert.equal(cell.maxMicroBatch, VRAM_TABLE.laptop16[arch].maxMicroBatch, `${arch} reuses the 16 GB floor`);
  }
});

test('an arch with no measurement falls back to batch 1, flagged inferred', () => {
  for (const tier of ['desktop32', 'mid24', 'laptop16']) {
    const c = vramCellFor(tier, 'zimage');
    assert.equal(c.maxMicroBatch, 1, tier);
    assert.equal(c.measured, false, tier);
  }
});

// --- route rules ----------------------------------------------------------------------------

test('desktop reaches effective batch with batch_size, capped by the dataset gate', () => {
  const big = suggestBatch({ itemCount: 150, arch: 'sdxl', tier: 'desktop32' });
  assert.deepEqual([big.batchSize, big.gradAccum, big.effective, big.route], [4, 1, 4, 'batch']);
  assert.equal(big.measured, true);

  const small = suggestBatch({ itemCount: 20, arch: 'sdxl', tier: 'desktop32' });
  assert.deepEqual([small.batchSize, small.gradAccum, small.effective], [2, 1, 2]);
  assert.equal(small.datasetCeiling, 2);
});

test('desktop is VRAM-capped where batch 4 is untested, and names it', () => {
  const plan = suggestBatch({ itemCount: 150, arch: 'flux2_klein_9b', tier: 'desktop32' });
  assert.equal(plan.datasetCeiling, 4);
  assert.equal(plan.vramCeiling, 2);
  assert.deepEqual([plan.batchSize, plan.gradAccum, plan.effective], [2, 1, 2]);
  assert.ok(plan.reasons.some(r => /VRAM-capped at 2/.test(r)));
});

test('laptop reaches effective batch with gradient_accumulation at batch 1', () => {
  const plan = suggestBatch({ itemCount: 25, arch: 'anima', tier: 'laptop16' });
  assert.deepEqual([plan.batchSize, plan.gradAccum, plan.effective, plan.route], [1, 2, 2, 'accum']);
  // VRAM does not bind accumulation: Krea 2 fits only batch 1 on the laptop but still
  // reaches effective 2 through accumulation
  const krea = suggestBatch({ itemCount: 25, arch: 'krea2', tier: 'laptop16' });
  assert.deepEqual([krea.batchSize, krea.gradAccum, krea.effective, krea.route], [1, 2, 2, 'accum']);
});

test('laptop + Klein reports that it does not fit at all', () => {
  const plan = suggestBatch({ itemCount: 60, arch: 'flux2_klein_4b', tier: 'laptop16' });
  assert.equal(plan.fits, false);
  assert.equal(plan.route, 'none');
  assert.match(plan.reasons[0], /does not fit/);
});

test('fused Automagic takes the batch_size route on every tier', () => {
  // desktop: same as plain desktop rule
  const d = suggestBatch({ itemCount: 150, arch: 'anima', tier: 'desktop32', optimizer: 'automagic3' });
  assert.deepEqual([d.batchSize, d.gradAccum, d.route], [4, 1, 'batch']);
  // laptop, arch that fits batch 2: batch_size 2, no accumulation
  const l = suggestBatch({ itemCount: 25, arch: 'anima', tier: 'laptop16', optimizer: 'automagic3' });
  assert.deepEqual([l.batchSize, l.gradAccum, l.effective, l.route], [2, 1, 2, 'batch']);
  // laptop, arch that fits only batch 1: effective batch 1, and it says why
  const k = suggestBatch({ itemCount: 25, arch: 'krea2', tier: 'laptop16', optimizer: 'automagic3' });
  assert.deepEqual([k.batchSize, k.gradAccum, k.effective], [1, 1, 1]);
  assert.ok(k.reasons.some(r => /fused Automagic/.test(r)));
  // unfused Automagic accumulates like any other optimizer
  const u = suggestBatch({ itemCount: 25, arch: 'krea2', tier: 'laptop16', optimizer: 'automagic3', fused: false });
  assert.deepEqual([u.batchSize, u.gradAccum, u.effective, u.route], [1, 2, 2, 'accum']);
});

// --- invariants ---------------------------------------------------------------------------

test('the plan never exceeds the dataset ceiling, on any tier, arch, optimizer or file count', () => {
  const archs = ['sdxl', 'anima', 'flux2_klein_4b', 'flux2_klein_9b', 'krea2', 'krea2:turbo', 'flux', 'zimage'];
  const tiers = ['desktop32', 'mid24', 'laptop16'];
  const opts = [undefined, 'adamw8bit', 'automagic3'];
  let checked = 0;
  for (const arch of archs) {
    for (const tier of tiers) {
      for (const optimizer of opts) {
        for (let n = 1; n <= 300; n += 1) {
          const plan = suggestBatch({ itemCount: n, arch, tier, optimizer });
          const healthy = maxHealthyBatch(n, arch);
          assert.ok(plan.effective <= healthy, `${arch}/${tier}/${optimizer}/${n}: ${plan.effective} > ${healthy}`);
          assert.ok(EFFECTIVE_BATCH_LADDER.includes(plan.effective), `${arch}/${tier}/${n}: off-ladder ${plan.effective}`);
          if (plan.fits) assert.ok(plan.batchSize <= plan.vramCeiling, `${arch}/${tier}/${n}: batch over VRAM cap`);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 20_000);
});
