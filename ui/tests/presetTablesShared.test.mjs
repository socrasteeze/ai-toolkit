import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { suggestSteps, exposureGauge, tableCapCount } from '../src/utils/stepSuggestion.ts';

// 2026-10-12: one machine-independent table per model, capped (3000; Klein 2500), and the gauge
// says "past the optimal dataset size" instead of "cool" beyond the cap point.
const dir = path.resolve(import.meta.dirname, '..', '..', 'presets');
const fam = a => (a.startsWith('flux2_klein') ? 'klein' : a === 'sdxl' ? 'sdxl' : a.split(':')[0]);
const all = readdirSync(dir)
  .filter(f => /^(anima|illxl|k4b|k9b|krea2)_.*\.json$/.test(f))
  .map(f => ({ name: f, j: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }));
const EXPECT = { krea2: [3000, 75], anima: [3000, 40], sdxl: [3000, 50], klein: [2500, 42] };

test('every preset of a model shares one table (laptop == desktop)', () => {
  const byFam = {};
  for (const { name, j } of all) {
    const f = fam(j.config.process[0].model.arch);
    const t = JSON.stringify({ points: j.meta.step_table.points, max: j.meta.step_table.max_steps });
    (byFam[f] ??= new Set()).add(t);
  }
  for (const [f, s] of Object.entries(byFam)) assert.equal(s.size, 1, `${f} has ${s.size} different tables`);
  assert.deepEqual(Object.keys(byFam).sort(), Object.keys(EXPECT).sort());
});

for (const { name, j } of all) {
  test(`${name}: capped table, optimized count, oversize tip`, () => {
    const arch = j.config.process[0].model.arch; const t = j.meta.step_table; const [cap, count] = EXPECT[fam(arch)];
    assert.equal(t.max_steps, cap);
    assert.equal(tableCapCount(t), count);
    assert.ok(j.meta.description.includes(`OPTIMIZED DATASET COUNT ~${count} images`));
    const at = n => suggestSteps({ itemCount: n, arch, batchSize: 1, gradientAccumulation: 1, stepTable: t });
    let prev = 0;
    for (let n = 5; n <= 300; n += 1) { const s = at(n).suggested; assert.ok(s >= prev && s <= cap, `${n}: ${s}`); prev = s; }
    assert.equal(at(count + 50).suggested, cap);
    assert.match(at(count + 50).explanation, /curate the dataset down/);
    for (const n of [count + 10, 200]) {
      const g = exposureGauge({ itemCount: n, arch, steps: at(n).suggested, batchSize: 1, gradientAccumulation: 1, stepTable: t });
      assert.equal(g.pastOptimalSize, true); assert.equal(g.optimalCount, count);
      assert.notEqual(g.band, 'cool'); assert.doesNotMatch(g.label, /undertrained/i);
      assert.match(g.label, new RegExp(`~${count} images and you have ${n}`));
    }
    const low = exposureGauge({ itemCount: 200, arch, steps: 500, batchSize: 1, gradientAccumulation: 1, stepTable: t });
    assert.notEqual(low.band, 'cool', 'past the cap point, never "cool"');
    const hot = exposureGauge({ itemCount: 200, arch, steps: 30000, batchSize: 1, gradientAccumulation: 1, stepTable: t });
    assert.ok(hot.band === 'warm' || hot.band === 'fry', 'overshoot still flagged');
    const before = exposureGauge({ itemCount: Math.max(5, count - 15), arch, steps: at(Math.max(5, count - 15)).suggested, batchSize: 1, gradientAccumulation: 1, stepTable: t });
    assert.equal(before.pastOptimalSize, false);
  });
}
