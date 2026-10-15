import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { suggestSteps, exposureGauge, tableCapCount } from '../src/utils/stepSuggestion.ts';

// One machine-independent table per model, capped (3000; Klein 2500).
// A suggestion cap must never hide low exposure or establish a dataset-size limit.
const dir = path.resolve(import.meta.dirname, '..', '..', 'presets');
const fam = a => (a.startsWith('flux2_klein') ? 'klein' : a === 'sdxl' ? 'sdxl' : a.split(':')[0]);
const all = readdirSync(dir)
  .filter(f => /^(anima|illxl|sdxl|k4b|k9b|krea2)_.*\.json$/.test(f))
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
  test(`${name}: capped suggestions preserve exposure bands`, () => {
    const arch = j.config.process[0].model.arch; const t = j.meta.step_table; const [cap, count] = EXPECT[fam(arch)];
    assert.equal(t.max_steps, cap);
    assert.equal(tableCapCount(t), count);
    const at = n => suggestSteps({ itemCount: n, arch, batchSize: 1, gradientAccumulation: 1, stepTable: t });
    let prev = 0;
    for (let n = 5; n <= 300; n += 1) { const s = at(n).suggested; assert.ok(s >= prev && s <= cap, `${n}: ${s}`); prev = s; }
    assert.equal(at(count + 50).suggested, cap);
    assert.match(at(count + 50).explanation, /suggestion cap, not a dataset-size limit/);
    assert.doesNotMatch(at(count + 50).explanation, /curate the dataset down/);
    for (const n of [count + 10, 200]) {
      const g = exposureGauge({ itemCount: n, arch, steps: at(n).suggested, batchSize: 1, gradientAccumulation: 1, stepTable: t });
      assert.equal(g.stepTableCapped, true); assert.equal(g.capImageCount, count);
      assert.notEqual(g.band, 'cool'); assert.doesNotMatch(g.label, /undertrained/i);
      assert.match(g.label, /Preset suggestions are capped/);
      assert.doesNotMatch(g.label, /optimal dataset|curate/i);
    }
    const low = exposureGauge({ itemCount: 200, arch, steps: 500, batchSize: 1, gradientAccumulation: 1, stepTable: t });
    assert.equal(low.band, 'cool', 'low exposure stays cool past the cap point');
    assert.match(low.label, /Cool/);
    const hot = exposureGauge({ itemCount: 200, arch, steps: 30000, batchSize: 1, gradientAccumulation: 1, stepTable: t });
    assert.ok(hot.band === 'warm' || hot.band === 'fry', 'overshoot still flagged');
    const before = exposureGauge({ itemCount: Math.max(5, count - 15), arch, steps: at(Math.max(5, count - 15)).suggested, batchSize: 1, gradientAccumulation: 1, stepTable: t });
    assert.equal(before.stepTableCapped, false);
  });
}

test('Illustrious/SDXL evidence table: same on illxl_* and sdxl_*, 1600/2000/2500/3000 at 20/30/40/50', () => {
  const fs2 = readdirSync(dir).filter(f => /^(illxl|sdxl)_.*\.json$/.test(f));
  assert.ok(fs2.length >= 8);
  for (const f of fs2) {
    const t = JSON.parse(readFileSync(path.join(dir, f), 'utf8')).meta.step_table;
    assert.deepEqual(t.points, [[20,1600],[30,2000],[40,2500],[50,3000]], f);
    assert.equal(t.max_steps, 3000, f);
  }
});
