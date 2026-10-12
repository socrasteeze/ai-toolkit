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
      const want = Math.max(50, Math.round(Math.min(t.max_steps ?? 6000, stepsFromTable(activeStepTable(t, p.model.arch), n)) / 50) * 50);
      assert.equal(r.suggested, want, `${n} images`);
      assert.ok(r.suggested >= prev, 'non-decreasing in dataset size');
      prev = r.suggested;
    }
    const half = suggestSteps({ itemCount: 50, arch: p.model.arch, batchSize: 1, gradientAccumulation: 2, stepTable: t });
    const full = suggestSteps({ itemCount: 50, arch: p.model.arch, batchSize: 1, gradientAccumulation: 1, stepTable: t });
    assert.ok(Math.abs(half.suggested * 2 - full.suggested) <= 100, 'divides by effective batch');
    assert.ok(exposureGauge({ itemCount: 30, arch: p.model.arch, steps: p.train.steps, batchSize: 1, gradientAccumulation: 1, stepTable: t }));
  });
}
