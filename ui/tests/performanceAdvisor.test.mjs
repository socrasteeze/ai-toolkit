import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performancePlan, selectedLocalGpu } from '../src/utils/performanceAdvisor.ts';

const gpu = (index = 0, name = 'NVIDIA GeForce RTX 5090', free = 24000) => ({
  index, name, memory: { total: 32607, free, used: 32607 - free },
});
const job = (arch = 'anima') => ({
  config: { process: [{
    type: 'diffusion_trainer',
    network: { type: 'lora', linear: 32 },
    model: { arch, model_kwargs: {}, quantize: false, layer_offloading: false },
    train: {
      optimizer: 'automagic4', optimizer_params: { fused: true, min_lr: 1e-8, max_lr: 1e-3 },
      lr: 1e-6, batch_size: 1, gradient_accumulation: 1, steps: 2000,
      gradient_checkpointing: true, cache_text_embeddings: false, train_text_encoder: false,
    },
    datasets: [{ resolution: [768, 1024], caption_dropout_rate: 0.1, controls: [], num_frames: 1 }],
  }] },
});
const planFor = config => performancePlan(config, '0', [gpu()]);
const row = (plan, id) => plan.rows.find(r => r.id === id);

test('GPU selection uses the selected local index and rejects remote, multi-GPU and malformed IDs', () => {
  const cards = [gpu(0, 'RTX 4090'), gpu(2)];
  assert.equal(selectedLocalGpu('0', cards).name, 'RTX 4090');
  assert.equal(selectedLocalGpu('2', cards).index, 2);
  for (const id of [null, '', 'peer:2', '0,2', '2oops', '-1', 'mps', '9']) {
    assert.equal(selectedLocalGpu(id, cards), null, String(id));
  }
  assert.equal(performancePlan(job(), '0', cards), null);
});

test('missing or invalid GPU memory never produces actionable advice', () => {
  for (const cards of [[], [gpu(0, 'RTX 5090', NaN)], [gpu(0, 'RTX 5090', -1)], [gpu(0, 'RTX 5090', 40000)]]) {
    const plan = performancePlan(job(), '0', cards);
    assert.equal(plan.rows.length, 0);
    assert.match(plan.notice, /live memory data/);
  }
  assert.equal(performancePlan(job(), '0', [gpu(0, 'RTX 5090', 0)]).freeMiB, 0);
  assert.equal(performancePlan(job(), '0', [gpu(0, 'RTX 5090 Laptop GPU')]), null);
});

test('profile excludes sliders, edit controls, video, other models and full fine-tunes', () => {
  const edits = [
    p => { p.type = 'concept_slider'; },
    p => { p.model.model_kwargs.edit = true; },
    p => { p.model.arch = 'krea2:o_edit'; },
    p => { p.datasets[0].controls = ['fixture']; },
    p => { p.datasets[0].control_path_2 = 'fixture'; },
    p => { p.datasets[0].control_from_same_folder = true; },
    p => { p.datasets[0].num_frames = 8; },
    p => { p.datasets[0].do_audio = true; },
    p => { delete p.network; },
    p => { p.model.arch = 'flux2'; },
  ];
  for (const edit of edits) {
    const config = job(); edit(config.config.process[0]);
    assert.equal(planFor(config), null);
  }
  assert.equal(planFor(job('krea2:turbo')).model, 'Krea 2');
});

test('optimizer and accumulation choices are preserved, including unfused Automagic v4', () => {
  for (const edit of [
    p => { p.train.optimizer = 'adamw'; },
    p => { p.train.gradient_accumulation = 4; },
    p => { p.train.gradient_accumulation_steps = -1; },
    p => { p.train.gradient_accumulation_steps = 2; },
  ]) {
    const config = job(); edit(config.config.process[0]);
    const before = structuredClone(config);
    assert.equal(planFor(config).rows.length, 0);
    assert.deepEqual(config, before);
  }
  const config = job(); config.config.process[0].train.optimizer_params.fused = false;
  assert.ok(planFor(config).rows.length);
  assert.equal(config.config.process[0].train.optimizer_params.fused, false);
});

test('cache advice covers every dataset without changing training or optimizer parameters', () => {
  const config = job();
  config.config.process[0].datasets.push({ resolution: [512], batch_size: 2, cache_latents_to_disk: true });
  const before = structuredClone(config);
  const plan = planFor(config);
  assert.match(plan.context, /batch 1\/2/);
  assert.match(plan.context, /resolution 512\/768\/1024/);
  assert.deepEqual(row(plan, 'latents').changes.map(c => c.path), [
    'config.process[0].datasets[0].cache_latents',
    'config.process[0].datasets[0].cache_latents_to_disk',
    'config.process[0].datasets[1].cache_latents',
  ]);
  assert.deepEqual(row(plan, 'text').changes, [{ path: 'config.process[0].train.cache_text_embeddings', value: true }]);
  assert.deepEqual(config, before);
});

test('cache actions stop at image or token augmentation and text encoder training', () => {
  for (const key of ['augments', 'augmentations', 'random_crop', 'random_scale']) {
    const config = job(); config.config.process[0].datasets[0][key] = key.startsWith('random') ? true : ['fixture'];
    const result = row(planFor(config), 'latents');
    assert.equal(result.status, 'Review');
    assert.deepEqual(result.changes, []);
  }
  for (const edit of [
    p => { p.datasets[0].shuffle_tokens = true; },
    p => { p.datasets[0].token_dropout_rate = 0.1; },
    p => { p.train.train_text_encoder = true; },
  ]) {
    const config = job(); edit(config.config.process[0]);
    assert.deepEqual(row(planFor(config), 'text').changes, []);
    assert.equal(row(planFor(config), 'text').status, 'Review');
  }
  assert.equal(row(planFor(job()), 'text').status, 'Candidate', 'caption dropout has its own cached blank embedding');
});

test('existing caches and unmeasured speed settings have no apply actions', () => {
  for (const arch of ['anima', 'krea2']) {
    const config = job(arch);
    Object.assign(config.config.process[0].datasets[0], { cache_latents: true, cache_latents_to_disk: true, cache_text_embeddings: true });
    const plan = planFor(config);
    assert.equal(row(plan, 'latents').status, 'Enabled');
    assert.equal(row(plan, 'text').status, 'Enabled');
    assert.ok(plan.rows.every(r => r.changes.length === 0));
    for (const id of ['compile', 'checkpoint', 'memory']) assert.equal(row(plan, id).status, 'Untested');
    config.config.process[0].model.layer_offloading = true;
    assert.equal(row(planFor(config), 'compile').status, 'Review');
  }
});

// Render the actual TSX with the installed compiler. This needs no server or GPU.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { renderToStaticMarkup } = require('react-dom/server');
const { createElement } = require('react');
const source = readFileSync(new URL('../src/components/PerformanceAdvisor.tsx', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const module = { exports: {} };
new Function('require', 'module', 'exports', outputText)(require, module, module.exports);
const PerformanceAdvisor = module.exports.default;

test('panel renders memory and untested states, and cache buttons only apply the listed fields', () => {
  const plan = planFor(job());
  const changes = [];
  const props = { plan, setJobConfig: (value, path) => changes.push({ path, value }) };
  const html = renderToStaticMarkup(createElement(PerformanceAdvisor, props));
  assert.match(html, /5090 Performance/);
  assert.match(html, /23.4 GiB free/);
  assert.match(html, /Untested/);
  assert.equal((html.match(/<button/g) || []).length, 2);
  const visit = element => {
    if (!element || typeof element !== 'object') return;
    if (Array.isArray(element)) return element.forEach(visit);
    if (element.type === 'button') element.props.onClick();
    visit(element.props?.children);
  };
  visit(PerformanceAdvisor(props));
  assert.deepEqual(changes, plan.rows.flatMap(r => r.changes));
  assert.equal(renderToStaticMarkup(createElement(PerformanceAdvisor, { ...props, plan: null })), '');
  const blocked = performancePlan(job(), 'peer:0', [gpu()]);
  assert.doesNotMatch(renderToStaticMarkup(createElement(PerformanceAdvisor, { ...props, plan: blocked })), /<button/);
});
