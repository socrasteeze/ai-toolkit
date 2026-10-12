import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { suggestSteps, exposureGauge, getHeuristic, getArchRecipe, krea2StepsPerItem } from '../src/utils/stepSuggestion.ts';

// 2026-10-12: everything the panel shows is computed for the exact image count.
const preset = n => JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', '..', 'presets', `${n}.json`), 'utf8'));
const COUNTS = [25, 27, 29];

test('krea2 exposure target is continuous, not bracketed', () => {
  const spi = COUNTS.map(krea2StepsPerItem);
  assert.ok(spi[0] > spi[1] && spi[1] > spi[2], spi.join(','));
  const raw = COUNTS.map(n => getHeuristic('krea2', n).stepsPerItem * n);
  assert.ok(raw[0] < raw[1] && raw[1] < raw[2], 'steps grow with count');
  assert.equal(krea2StepsPerItem(20), 45);
  assert.ok(Math.abs(krea2StepsPerItem(36) - 32) < 1e-9);
  assert.equal(krea2StepsPerItem(250), 20);
  assert.equal(krea2StepsPerItem(0), 32);
  let prev = 0;
  for (let n = 1; n <= 400; n += 1) {
    const v = getHeuristic('krea2', n).stepsPerItem * n;
    assert.ok(v >= prev - 1e-9, `monotonic at ${n}`);
    prev = v;
  }
});

for (const name of ['anima_background_gen_lora', 'illxl_char_lora', 'k4b_char_lora', 'k9b_char_lora', 'krea2_char_lora', 'krea2_5090_char_lora']) {
  test(`${name}: 25 / 27 / 29 images each computed for their own count`, () => {
    const j = preset(name); const arch = j.config.process[0].model.arch; const t = j.meta.step_table;
    const r = COUNTS.map(n => suggestSteps({ itemCount: n, arch, batchSize: 1, gradientAccumulation: 1, stepTable: t }));
    for (let i = 0; i < r.length; i += 1) {
      assert.match(r[i].explanation, new RegExp(`^${COUNTS[i]} files`), 'explanation states the real count');
      assert.doesNotMatch(r[i].explanation, /Infinity/);
      if (i) assert.ok(r[i].suggested >= r[i - 1].suggested, 'non-decreasing');
    }
    if (!name.startsWith('krea2_char')) assert.ok(r[0].suggested < r[2].suggested, 'differs across 25 -> 29');
    const g = COUNTS.map(n => exposureGauge({ itemCount: n, arch, steps: 1800, batchSize: 1, gradientAccumulation: 1, stepTable: t }).exposures);
    assert.ok(g[0] > g[1] && g[1] > g[2], 'passes computed per count');
  });
}

test('recipe notes name the exact count and the next band', () => {
  for (const n of COUNTS) {
    const r = getArchRecipe('krea2', n, '');
    assert.ok(r.notes.startsWith(`For your ${n} images (small band`), r.notes.slice(0, 80));
    assert.ok(r.notes.includes(`${30 - n} more image(s)`));
  }
  assert.ok(getArchRecipe('sdxl', 27, 'OnomaAIResearch/Illustrious-XL-v1.0').notes.startsWith('For your 27 images'));
});

test('target-derived tail: Anima / illxl past the table read healthy at the suggested steps', () => {
  for (const name of ['anima_background_gen_lora', 'illxl_char_lora']) {
    const j = preset(name); const arch = j.config.process[0].model.arch; const t = j.meta.step_table;
    let prev = 0;
    for (const n of [40, 45, 57, 60, 100, 200]) {
      const s = suggestSteps({ itemCount: n, arch, batchSize: 1, gradientAccumulation: 1, stepTable: t }).suggested;
      assert.ok(s >= prev, `${name} monotonic at ${n}`); prev = s;
    }
    for (const n of [100, 200]) {
      const s = suggestSteps({ itemCount: n, arch, batchSize: 1, gradientAccumulation: 1, stepTable: t }).suggested;
      assert.equal(exposureGauge({ itemCount: n, arch, steps: s, batchSize: 1, gradientAccumulation: 1, stepTable: t }).band, 'healthy', `${name} ${n}`);
    }
  }
});

test('passes in the explanation are rounded up', () => {
  const r = suggestSteps({ itemCount: 27, arch: 'krea2', batchSize: 1, gradientAccumulation: 1 });
  assert.match(r.explanation, /seen \u2248\d+\u00d7/);
});
