import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Pins krea2_character_lora_5090 to the community spec it was added for (2026-10-11), and
// its step-scaling table to the text a user actually reads. The step advisor is per-arch, so
// the table lives in the preset description - this test is what keeps the two in sync.
const file = path.resolve(import.meta.dirname, '..', '..', 'presets', 'krea2_character_lora_5090.json');
const preset = JSON.parse(readFileSync(file, 'utf8'));
const p = preset.config.process[0];

test('krea2_character_lora_5090 matches the community spec', () => {
  assert.equal(p.model.arch, 'krea2');
  assert.equal(p.model.quantize, false);
  assert.equal(p.model.quantize_te, false);
  assert.equal(p.network.type, 'lora');
  assert.equal(p.network.linear, 32);
  assert.equal(p.network.linear_alpha, 32);
  assert.equal(p.train.optimizer, 'adamw8bit');
  assert.equal(p.train.lr, 1e-4);
  assert.deepEqual(p.train.ema_config, { use_ema: true, ema_decay: 0.98 });
  assert.equal(p.train.batch_size, 1);
  assert.equal(p.train.gradient_accumulation, 1);
  assert.equal(p.train.steps, 1800);
  assert.deepEqual(p.datasets[0].resolution, [1024]);
  assert.equal(p.datasets[0].caption_ext, 'txt');
  assert.equal(p.save.save_every, 250);
  assert.ok(p.save.max_step_saves_to_keep * p.save.save_every >= 3500 * 4, 'must keep every checkpoint');
});

test('krea2_character_lora_5090 samples render at 1024 with the trigger placeholder', () => {
  assert.equal(p.sample.width, 1024);
  assert.equal(p.sample.height, 1024);
  assert.ok(p.sample.samples.length > 0);
  for (const s of p.sample.samples) assert.match(s.prompt, /\[trigger\]/);
});

test('krea2_character_lora_5090 description carries the step table and community caveat', () => {
  const d = preset.meta.description;
  for (const row of ['20 images ~1500', '30 ~1800', '50 ~2500', '100 ~3500']) assert.ok(d.includes(row), row);
  assert.match(d, /community/i);
  assert.match(d, /NOT measured on this fork/);
});
