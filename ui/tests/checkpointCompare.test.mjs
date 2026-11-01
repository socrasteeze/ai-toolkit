// Contract tests for ui/src/server/compare.ts, the pure half of Checkpoint Compare.
// Fixtures use invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bucketFor,
  buildPlan,
  injectTrigger,
  isForbiddenPath,
  listCheckpoints,
  listReferences,
  promoteCheckpoint,
  promoteDest,
  promotedName,
  readRunInfo,
  renderKey,
  resolveReference,
  resolveRunFolder,
} from '../src/server/compare.ts';

const scratch = fn => async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'compare-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const params = { prompt: 'p', neg: '', seed: 42, width: 832, height: 1216, steps: 30, cfg: 4 };

test('hard rule: archive and IRL folders are forbidden, lookalikes are not', () => {
  for (const bad of ['X:\\lib\\irl', 'D:\\datasets\\_Archive\\x', 'D:\\a\\old_archive', 'D:\\irl_faces\\a', 'E:\\my-IRL\\a']) {
    assert.equal(isForbiddenPath(bad), true, bad);
  }
  for (const ok of ['D:\\datasets\\girl_portraits', 'D:\\datasets\\swirl', 'E:\\training_runs\\sample_run']) {
    assert.equal(isForbiddenPath(ok), false, ok);
  }
});

test('run folders must sit under the training root or a trained folder, and never a forbidden one', scratch(root => {
  const training = path.join(root, 'runs');
  mkdirSync(path.join(training, 'sample_run'), { recursive: true });
  mkdirSync(path.join(training, 'irl_run'));
  mkdirSync(path.join(root, 'lib', 'trained', 'sample_run'), { recursive: true });
  mkdirSync(path.join(root, 'elsewhere'));
  assert.equal(resolveRunFolder('sample_run', training), path.join(training, 'sample_run'));
  assert.equal(resolveRunFolder(path.join(root, 'lib', 'trained', 'sample_run'), training), path.join(root, 'lib', 'trained', 'sample_run'));
  assert.throws(() => resolveRunFolder(path.join(root, 'elsewhere'), training), /training folder/);
  assert.throws(() => resolveRunFolder('..\\elsewhere', training), /training folder/);
  assert.throws(() => resolveRunFolder('irl_run', training), /off limits/);
}));

test('checkpoints sort by step with the final last, across trainer and promoted names', scratch(dir => {
  for (const f of ['r.safetensors', 'r_000000200.safetensors', 'r_000000100.safetensors', 'r_s50.safetensors', 'notes.txt']) {
    writeFileSync(path.join(dir, f), '');
  }
  assert.deepEqual(listCheckpoints(dir).map(c => [c.step, c.label]), [
    [50, 'step 50'],
    [100, 'step 100'],
    [200, 'step 200'],
    [null, 'final'],
  ]);
}));

test('a digit-ending run name is not read as a step', scratch(dir => {
  writeFileSync(path.join(dir, 'run_v2.safetensors'), '');
  writeFileSync(path.join(dir, 'run_12.safetensors'), '');
  assert.deepEqual(listCheckpoints(dir).map(c => c.step), [null, null]);
}));

test('trigger handling matches inject_trigger_into_prompt', () => {
  assert.equal(injectTrigger('a [trigger] in (the) rain', 'tok'), 'a tok in (the) rain');
  assert.equal(injectTrigger('a [name] here', 'tok'), 'a tok here');
  assert.equal(injectTrigger('a photo', 'tok'), 'tok a photo');
  assert.equal(injectTrigger('tok a photo', 'tok'), 'tok a photo');
  assert.equal(injectTrigger('[trigger] statue', null), ' statue');
  assert.equal(injectTrigger('statue', null), 'statue');
});

test('bucket port matches toolkit/buckets.py', () => {
  // expected values computed by running get_bucket_for_image_size
  assert.deepEqual(bucketFor(1000, 1500, 1024, 32), { width: 832, height: 1248 });
  assert.deepEqual(bucketFor(1024, 1024, 1024, 32), { width: 1024, height: 1024 });
  assert.deepEqual(bucketFor(512, 768, 1024, 32), { width: 512, height: 768 });
  assert.deepEqual(bucketFor(3000, 2000, 1024, 16), { width: 1248, height: 832 });
});

test('cache key changes with every input in the handoff tuple and stays generic', () => {
  const c = { file: 'r_000000100.safetensors', mtimeMs: 1, step: 100 };
  const base = renderKey(c, params);
  assert.match(base, /^s000000100_[0-9a-f]{12}\.png$/);
  assert.equal(renderKey(c, { ...params }), base);
  for (const change of [{ prompt: 'q' }, { seed: 1 }, { width: 64 }, { height: 64 }, { steps: 1 }, { cfg: 5 }, { neg: 'n' }]) {
    assert.notEqual(renderKey(c, { ...params, ...change }), base, JSON.stringify(change));
  }
  assert.notEqual(renderKey({ ...c, mtimeMs: 2 }, params), base);
  assert.notEqual(renderKey({ ...c, file: 'other.safetensors' }, params), base);
  assert.match(renderKey(null, params), /^baseline_/);
});

test('run info, plan and references work from a config, and the plan rejects a random seed', scratch(root => {
  const run = path.join(root, 'sample_run');
  const data = path.join(root, 'data');
  mkdirSync(run);
  mkdirSync(path.join(data, 'sub'), { recursive: true });
  mkdirSync(path.join(data, 'irl_extra'));
  mkdirSync(path.join(data, '_controls'));
  mkdirSync(path.join(data, '.thumbs'));
  for (const f of ['a.png', 'sub/b.jpg', 'irl_extra/no.png', '_controls/no.png', '.thumbs/no.png', 'a.txt']) writeFileSync(path.join(data, f), '');
  writeFileSync(path.join(run, 'sample_run_000000100.safetensors'), '');
  writeFileSync(path.join(run, 'sample_run.safetensors'), '');
  writeFileSync(
    path.join(run, '.job_config.json'),
    JSON.stringify({
      config: {
        process: [
          {
            trigger_word: 'tok',
            model: { arch: 'anima', name_or_path: 'base', quantize: true, compile: true, model_kwargs: {} },
            datasets: [{ folder_path: data, resolution: [512, 1024] }],
            sample: { sample_steps: 30, guidance_scale: 4, neg: 'bad' },
          },
        ],
      },
    }),
  );
  const info = readRunInfo(run, root);
  assert.equal(info.supported, true);
  assert.equal(info.resolution, 1024);
  assert.equal(info.divisibility, 32);
  assert.deepEqual(info.model, { arch: 'anima', name_or_path: 'base', quantize: true });
  assert.deepEqual(info.sample, { steps: 30, cfg: 4, neg: 'bad' });
  assert.deepEqual(listReferences(info), ['a.png', path.join('sub', 'b.jpg')]);
  assert.equal(resolveReference(info, 'a.png'), path.join(data, 'a.png'));
  assert.throws(() => resolveReference(info, '..\\sample_run\\.job_config.json'), /not found/);
  assert.throws(() => resolveReference(info, 'irl_extra/no.png'), /off limits/);

  const plan = buildPlan(info, { ...params, bleed: '[trigger] statue', baseline: true });
  assert.equal(plan.length, 6); // baseline + 2 checkpoints, 2 prompts each
  assert.equal(plan[0].loraPath, null);
  assert.equal(plan[0].params.prompt, 'tok p');
  assert.equal(plan[1].params.prompt, ' statue');
  assert.equal(new Set(plan.map(p => p.key)).size, 6);
  assert.throws(() => buildPlan(info, { ...params, seed: -1 }), /Seed/);
  assert.throws(() => buildPlan(info, { ...params, prompt: ' ' }), /empty/);
  assert.throws(() => buildPlan(info, { ...params, cfg: 'x' }), /CFG/);
}));

test('unsupported archs say so, and FLUX.1 is not supported', scratch(root => {
  const run = path.join(root, 'r');
  mkdirSync(run);
  const write = arch =>
    writeFileSync(path.join(run, '.job_config.json'), JSON.stringify({ process: [{ model: { arch }, datasets: [{}] }] }));
  for (const [arch, expected] of [['anima', true], ['krea2', true], ['flux2_klein_9b', true], ['flux', false], ['sdxl', false]]) {
    write(arch);
    assert.equal(readRunInfo(run, root).supported, expected, arch);
  }
}));

test('a promoted folder with no config falls back to the run of the same name', scratch(root => {
  const training = path.join(root, 'runs');
  const promoted = path.join(root, 'lib', 'trained', 'r');
  mkdirSync(path.join(training, 'r'), { recursive: true });
  mkdirSync(promoted, { recursive: true });
  writeFileSync(path.join(training, 'r', '.job_config.json'), JSON.stringify({ process: [{ model: { arch: 'anima' } }] }));
  assert.equal(readRunInfo(promoted, training).arch, 'anima');
  assert.throws(() => readRunInfo(path.join(root, 'lib'), training), /job_config/);
}));

test('promote paths match promote.py, including klein before flux and the real library folder', () => {
  const real = p => `X:\\real\\${path.win32.basename(p)}`;
  assert.equal(promoteDest('anima', 'r', 'r_s400', real), 'X:\\real\\anima\\trained\\r\\r_s400.safetensors');
  assert.equal(promoteDest('flux2_klein_9b', 'r', 'r', real), 'X:\\real\\klein\\trained\\r\\r.safetensors');
  assert.equal(promoteDest('krea2', 'r', 'r', real), 'X:\\real\\krea\\trained\\r\\r.safetensors');
  assert.throws(() => promoteDest('mystery', 'r', 'r', real), /No library folder/);
  assert.throws(() => promoteDest('krea2', 'irl', 'r', real), /off limits/);
  assert.equal(promotedName('r', { step: 400 }), 'r_s400');
  assert.equal(promotedName('r', { step: null }), 'r');
});

test('promote copies, keeps the source and its mtime, and refuses to overwrite by default', scratch(async root => {
  const src = path.join(root, 'src.safetensors');
  const dest = path.join(root, 'trained', 'r', 'r.safetensors');
  writeFileSync(src, 'new');
  utimesSync(src, 1000, 1000);
  assert.equal(await promoteCheckpoint(src, dest, false), 'copied');
  assert.equal(existsSync(src), true);
  assert.equal(readFileSync(dest, 'utf-8'), 'new');
  assert.equal(statSync(dest).mtimeMs, statSync(src).mtimeMs);
  writeFileSync(dest, 'old');
  assert.equal(await promoteCheckpoint(src, dest, false), 'exists');
  assert.equal(readFileSync(dest, 'utf-8'), 'old');
  assert.equal(await promoteCheckpoint(src, dest, true), 'copied');
  assert.equal(readFileSync(dest, 'utf-8'), 'new');
}));
