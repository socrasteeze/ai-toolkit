import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { suggestSteps, exposureGauge, activeStepTable } from '../src/utils/stepSuggestion.ts';
import { suggestBatch } from '../src/utils/batchAdvisor.ts';

// Pins flux2_klein_9b_character_lora_laptop16gb (2026-10-12): community-derived 16 GB memory
// profile at 1024 on top of the unchanged 9B character recipe, and its step table = the
// fork's existing 9B rule (60/image, 1000-2500).
const file = path.resolve(import.meta.dirname, '..', '..', 'presets', 'flux2_klein_9b_character_lora_laptop16gb.json');
const preset = JSON.parse(readFileSync(file, 'utf8'));
const p = preset.config.process[0];
const table = preset.meta.step_table;

test('klein 9b laptop preset: recipe and 16 GB memory settings', () => {
  assert.equal(p.model.arch, 'flux2_klein_9b');
  assert.equal(p.model.name_or_path, 'black-forest-labs/FLUX.2-klein-base-9B');
  assert.equal(p.network.type, 'lora');
  assert.equal(p.network.linear, 16);
  assert.equal(p.network.linear_alpha, 16);
  assert.equal(p.train.optimizer, 'adamw8bit');
  assert.equal(p.train.lr, 1e-4);
  assert.equal(p.train.batch_size, 1);
  assert.equal(p.train.gradient_accumulation, 1);
  assert.equal(p.train.gradient_checkpointing, true);
  assert.equal(p.train.cache_text_embeddings, true);
  assert.equal(p.train.unload_text_encoder, true);
  assert.equal(p.train.disable_sampling, true);
  assert.deepEqual(p.datasets[0].resolution, [1024]);
  assert.equal(p.datasets[0].cache_latents_to_disk, true);
  assert.equal(p.model.quantize, true);
  assert.equal(p.model.quantize_te, true);
  assert.equal(p.model.low_vram, true);
  assert.equal(p.model.layer_offloading, true);
  assert.equal(p.model.layer_offloading_text_encoder_percent, 1);
  assert.ok(p.model.layer_offloading_transformer_percent >= 0.7 && p.model.layer_offloading_transformer_percent <= 1);
  assert.ok(p.save.max_step_saves_to_keep * p.save.save_every >= 2500, 'keeps every checkpoint up to the 2500 cap');
});

test('klein 9b laptop preset: 1024 samples with the trigger placeholder', () => {
  assert.equal(p.sample.width, 1024);
  assert.equal(p.sample.height, 1024);
  assert.ok(p.sample.samples.length > 0);
  for (const s of p.sample.samples) assert.match(s.prompt, /\[trigger\]/);
});

test('klein 9b laptop preset: description caveats', () => {
  const d = preset.meta.description;
  assert.match(d, /COMMUNITY-DERIVED/);
  assert.match(d, /NOT measured on the laptop/);
  assert.match(d, /IF YOU OOM, in order/);
  assert.match(d, /Sysmem Fallback/);
  assert.match(d, /qfloat8 -> torchao float8/);
});

test('klein 9b laptop step table reproduces the 9B rule', () => {
  assert.equal(table.arch, 'flux2_klein_9b');
  assert.equal(table.max_steps, 2500);
  const at = n => suggestSteps({ itemCount: n, arch: 'flux2_klein_9b', batchSize: 1, gradientAccumulation: 1, stepTable: table });
  const rule = n => suggestSteps({ itemCount: n, arch: 'flux2_klein_9b', batchSize: 1, gradientAccumulation: 1 });
  for (const [n, want] of [[20, 1200], [25, 1500], [30, 1800], [40, 2400], [60, 2500], [200, 2500]]) {
    assert.equal(at(n).suggested, want, `${n} images`);
    assert.equal(at(n).heuristicSource, 'preset');
    assert.equal(rule(n).suggested, want, `${n} images (per-arch rule agrees)`);
  }
  assert.equal(at(30 * 2).suggested, 2500);
  assert.equal(suggestSteps({ itemCount: 30, arch: 'flux2_klein_9b', batchSize: 1, gradientAccumulation: 2, stepTable: table }).suggested, 900);
  assert.ok(exposureGauge({ itemCount: 30, arch: 'flux2_klein_9b', steps: 1800, batchSize: 1, gradientAccumulation: 1, stepTable: table }));
});

test('other Klein presets keep the per-arch suggestion', () => {
  assert.equal(activeStepTable(table, 'flux2_klein_4b'), null, 'table ignored for the 4B');
  for (const arch of ['flux2_klein_4b', 'flux2_klein_9b']) {
    const r = suggestSteps({ itemCount: 10, arch, batchSize: 1, gradientAccumulation: 1 });
    assert.equal(r.suggested, 1000);
    assert.notEqual(r.heuristicSource, 'preset');
  }
});

test('laptop batch plan: Klein still OOM without offloading, inferred batch 1 with it', () => {
  const off = suggestBatch({ itemCount: 30, arch: 'flux2_klein_9b', tier: 'laptop16', optimizer: 'adamw8bit' });
  assert.equal(off.fits, false);
  assert.equal(off.measured, true);
  const on = suggestBatch({ itemCount: 30, arch: 'flux2_klein_9b', tier: 'laptop16', optimizer: 'adamw8bit', layerOffloading: true });
  assert.equal(on.fits, true);
  assert.equal(on.batchSize, 1);
  assert.equal(on.measured, false);
  assert.match(on.vramNote, /UNMEASURED/);
  const desk = suggestBatch({ itemCount: 30, arch: 'flux2_klein_9b', tier: 'desktop32', optimizer: 'adamw8bit', layerOffloading: true });
  assert.equal(desk.vramCeiling, 2, 'desktop cell unchanged');
});
