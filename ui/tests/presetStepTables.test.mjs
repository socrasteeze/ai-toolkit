import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { suggestSteps, exposureGauge, stepsFromTable, activeStepTable } from '../src/utils/stepSuggestion.ts';

// 2026-10-12: every Anima / IllustriousXL / Klein 4B / Klein 9B / Krea 2 preset ships a
// per-preset dataset-size table (meta.step_table) and the Step Suggestion panel uses it.
const dir = path.resolve(import.meta.dirname, '..', '..', 'presets');
const presets = readdirSync(dir)
  .filter(f => f.endsWith('.json') && /^(anima|illxl|k4b|k9b|krea2)_/.test(f))
  .map(f => ({ name: f.replace(/\.json$/, ''), json: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }));

test('the covered families are all present', () => {
  for (const fam of ['anima_', 'illxl_', 'k4b_', 'k9b_', 'krea2_']) assert.ok(presets.some(p => p.name.startsWith(fam)), fam);
  assert.ok(presets.length >= 25);
});

for (const { name, json } of presets) {
  test(`${name} has a step table the panel uses`, () => {
    const p = json.config.process[0];
    const t = json.meta.step_table;
    assert.ok(t, 'meta.step_table missing');
    assert.equal(t.arch.split(':')[0], p.model.arch.split(':')[0]);
    assert.ok(activeStepTable(t, p.model.arch), 'table not active for its own arch');
    assert.match(json.meta.description, /step[ _]table/i, 'description must mention the table');
    let prev = 0;
    for (const n of [10, 20, 30, 50, 100, 150]) {
      const r = suggestSteps({ itemCount: n, arch: p.model.arch, batchSize: 1, gradientAccumulation: 1, stepTable: t });
      assert.equal(r.heuristicSource, 'preset', `${n} images`);
      const want = Math.max(50, Math.round(Math.min(t.max_steps ?? Infinity, stepsFromTable(activeStepTable(t, p.model.arch), n)) / 50) * 50);
      assert.equal(r.suggested, want, `${n} images`);
      assert.ok(r.suggested >= prev, 'non-decreasing in dataset size');
      prev = r.suggested;
    }
    assert.notEqual(t.max_steps, 6000, 'no forced 6000 cap');
    if (!p.model.arch.startsWith('flux2_klein')) {
      assert.equal(t.max_steps, undefined, 'non-Klein tables are uncapped');
      assert.equal(t.tail_per_item, 20, '+20/image beyond the last anchor');
      const last = t.points[t.points.length - 1];
      const at = n => suggestSteps({ itemCount: n, arch: p.model.arch, batchSize: 1, gradientAccumulation: 1, stepTable: t }).suggested;
      assert.equal(at(last[0] + 100), Math.round((last[1] + 2000) / 50) * 50, 'tail follows +20/image');
      assert.ok(at(400) > 6000 || last[1] + (400 - last[0]) * 20 <= 6000, 'no hard 6000 jump/cap');
      // gauge: past the table it judges against the arch target, so a very long run reads hot
      const g = exposureGauge({ itemCount: 200, arch: p.model.arch, steps: 40000, batchSize: 1, gradientAccumulation: 1, stepTable: t });
      assert.ok(g && g.band !== 'healthy' && g.band !== 'cool', 'gauge flags a long run past the table: ' + (g && g.band));
    } else {
      assert.equal(t.max_steps, 2500, 'Klein keeps its 2500 plateau');
    }
    const half = suggestSteps({ itemCount: 50, arch: p.model.arch, batchSize: 1, gradientAccumulation: 2, stepTable: t });
    const full = suggestSteps({ itemCount: 50, arch: p.model.arch, batchSize: 1, gradientAccumulation: 1, stepTable: t });
    assert.ok(Math.abs(half.suggested * 2 - full.suggested) <= 100, 'divides by effective batch');
    assert.ok(exposureGauge({ itemCount: 30, arch: p.model.arch, steps: p.train.steps, batchSize: 1, gradientAccumulation: 1, stepTable: t }));
  });
}
