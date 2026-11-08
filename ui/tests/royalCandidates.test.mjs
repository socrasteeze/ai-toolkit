// Contract tests for ui/src/server/royalCandidates.ts. Fixtures use invented names and values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { findLossDb, loadCandidates, readHeaderStep, scoreCheckpoints } from '../src/server/royalCandidates.ts';

const scratch = fn => async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'royal-'));
  try {
    await fn(dir, t);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const save = (step, file = `r_${String(step).padStart(9, '0')}.safetensors`) => ({ file, step, stepSource: 'metadata' });
const saves = (...steps) => steps.map(s => save(s));
const every300 = saves(300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000);
const range = (n, from = 1) => Array.from({ length: n }, (_, i) => i + from);
const row = (result, step) => result.checkpoints.find(c => c.step === step);
const picked = result => result.checkpoints.filter(c => c.recommended).map(c => c.step);

// deterministic noise so a failure reproduces
const noiseFrom = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;

const decayLog = (n = 3000) => {
  const noise = noiseFrom(7);
  const steps = range(n);
  return { steps, values: steps.map(s => 0.1 + 0.4 * Math.exp(-s / 250) + 0.02 * noise()) };
};

test('a spike rejects the save it lands on, and the last save is flagged final', () => {
  const { steps, values } = decayLog();
  for (let i = 1950; i < 2100; i++) values[i] += 0.08;
  const result = scoreCheckpoints(every300, steps, values, [1.0]);
  const spiked = row(result, 2100);
  assert.equal(spiked.recommended, false);
  assert.ok(spiked.reasons.some(r => r.startsWith('loss bump vs neighbours')));
  const last = row(result, 3000);
  assert.equal(last.isFinal, true);
  assert.ok(last.reasons.includes('final save'));
  assert.equal(result.checkpoints.filter(c => c.isFinal).length, 1);
  assert.ok(picked(result).length >= 3);
});

test('the ensemble is the mean of the windows and also rejects the spike', () => {
  const { steps, values } = decayLog();
  for (let i = 1950; i < 2100; i++) values[i] += 0.08;
  const fractions = [0.5, 0.75, 1.0];
  const each = fractions.map(f => row(scoreCheckpoints(every300, steps, values, [f]), 1800).score);
  const mean = row(scoreCheckpoints(every300, steps, values), 1800).score;
  assert.ok(Math.abs(mean - each.reduce((a, b) => a + b) / 3) < 0.002);
  assert.equal(row(scoreCheckpoints(every300, steps, values), 2100).recommended, false);
});

test('an early pick is added when every ranked pick is well past the plateau', () => {
  // flat from step 400; the first flat stretch is noisier, so ranking prefers later saves
  const steps = range(3000);
  const values = steps.map(s => {
    if (s <= 400) return 0.1 + 0.3 * (1 - s / 400);
    return 0.1 + (s % 2 ? 1 : -1) * (s <= 1500 ? 0.03 : 0.01);
  });
  const result = scoreCheckpoints(every300, steps, values, [1.0]);
  const early = result.checkpoints.filter(c => c.reasons.includes('early pick (at plateau onset)'));
  assert.equal(early.length, 1);
  assert.equal(early[0].recommended, true);
  assert.ok(early[0].step <= result.plateauStep + result.interval);
  assert.equal(result.plateauStep, 900);
  assert.equal(picked(result).length, 4);
});

test('picks stay at least one save interval apart', () => {
  const { steps, values } = decayLog();
  const result = scoreCheckpoints(every300, steps, values);
  const chosen = picked(result).sort((a, b) => a - b);
  chosen.slice(1).forEach((s, i) => assert.ok(s - chosen[i] >= result.interval));
});

test('fewer than four saves: all scored saves are recommended', () => {
  const { steps, values } = decayLog();
  const result = scoreCheckpoints(saves(1000, 2000, 3000), steps, values);
  assert.deepEqual(picked(result), [1000, 2000, 3000]);
});

test('one save has a finite interval and window, and is recommended', () => {
  const { steps, values } = decayLog();
  const result = scoreCheckpoints(saves(3000), steps, values);
  assert.equal(result.interval, 0);
  assert.equal(result.window, 100);
  assert.deepEqual(picked(result), [3000]);
  assert.equal(Number.isFinite(row(result, 3000).score), true);
});

test('a window with too few rows is unscored and not recommended', () => {
  const steps = range(30).map(i => i * 100);
  const values = steps.map(() => 0.1);
  const result = scoreCheckpoints(every300, steps, values);
  for (const c of result.checkpoints) {
    assert.equal(c.score, null);
    assert.equal(c.recommended, false);
    assert.ok(c.reasons.includes('no loss rows near this save'));
  }
});

test('saves past a truncated log are unscored, while a final save one step past the tail is scored', () => {
  const { steps, values } = decayLog(1200);
  const result = scoreCheckpoints(saves(300, 600, 900, 1200, 1500, 3000), steps, values);
  for (const step of [1500, 3000]) {
    assert.equal(row(result, step).score, null, String(step));
    assert.equal(row(result, step).recommended, false, String(step));
  }
  assert.equal(typeof row(result, 1200).score, 'number');

  const full = decayLog();
  const onePast = scoreCheckpoints(saves(1000, 2000, 2500, 3001), full.steps, full.values);
  assert.equal(typeof row(onePast, 3001).score, 'number');
});

test('a log written every ten steps still scores its final save, and a truncated one does not', () => {
  const noise = noiseFrom(11);
  const steps = range(299).map(i => i * 10); // ends at 2990, ten steps before the final save
  const values = steps.map(s => 0.1 + 0.4 * Math.exp(-s / 250) + 0.02 * noise());
  assert.equal(typeof row(scoreCheckpoints(every300, steps, values), 3000).score, 'number');

  const cut = scoreCheckpoints(every300, steps.slice(0, 119), values.slice(0, 119)); // ends at 1190
  assert.equal(typeof row(cut, 1200).score, 'number');
  assert.equal(row(cut, 1500).score, null);
  assert.equal(row(cut, 3000).score, null);
});

test('a constant loss log stays finite', () => {
  const steps = range(3000);
  const result = scoreCheckpoints(every300, steps, steps.map(() => 0.125));
  for (const c of result.checkpoints) assert.equal(Number.isFinite(c.score), true);
});

test('the final file wins a duplicate step, and the other copy is listed but not scored', () => {
  const { steps, values } = decayLog();
  const input = [...every300, save(3000, 'r.safetensors')];
  const result = scoreCheckpoints(input, steps, values);
  assert.equal(result.interval, 300); // a zero gap must not skew the median
  const copy = result.checkpoints.find(c => c.file === 'r_000003000.safetensors');
  const final = result.checkpoints.find(c => c.file === 'r.safetensors');
  assert.equal(copy.score, null);
  assert.equal(copy.recommended, false);
  assert.ok(copy.reasons.includes('same step as another save'));
  assert.equal(final.isFinal, true);
  assert.equal(typeof final.score, 'number');
  assert.equal(result.checkpoints.length, input.length);
});

test('an unknown step is listed, never scored and never recommended', () => {
  const { steps, values } = decayLog();
  const result = scoreCheckpoints([...every300, { file: 'mystery.safetensors', step: null, stepSource: null }], steps, values);
  const unknown = result.checkpoints.find(c => c.file === 'mystery.safetensors');
  assert.equal(unknown.score, null);
  assert.equal(unknown.recommended, false);
  assert.deepEqual(unknown.reasons, ['unknown step']);
});

const writeSafetensors = (file, trainingInfo) => {
  const json = Buffer.from(JSON.stringify({ __metadata__: { training_info: JSON.stringify(trainingInfo) } }));
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(json.length));
  writeFileSync(file, Buffer.concat([size, json, Buffer.alloc(16)]));
};

const writeLossDb = (file, key, steps, values) =>
  new Promise((resolve, reject) => {
    const done = err => (err ? reject(err) : undefined);
    const db = new sqlite3.Database(file);
    db.serialize(() => {
      db.run('CREATE TABLE metric_keys(key TEXT PRIMARY KEY, first_seen_step INT, last_seen_step INT)', done);
      db.run('CREATE TABLE metrics(step INT, key TEXT, value_real REAL, value_text TEXT, PRIMARY KEY(step, key))', done);
      db.run('INSERT INTO metric_keys VALUES (?, 1, 1)', [key], done);
      db.run('BEGIN', done);
      const insert = db.prepare('INSERT INTO metrics VALUES (?, ?, ?, NULL)');
      steps.forEach((s, i) => insert.run(s, key, values[i], done));
      insert.finalize(done);
      db.run('COMMIT', done);
      db.close(err => (err ? reject(err) : resolve()));
    });
  });

test('the step comes from the header, so a renamed file keeps it', scratch(dir => {
  const file = path.join(dir, 'renamed.safetensors');
  writeSafetensors(file, { step: 1200, epoch: 3 });
  assert.equal(readHeaderStep(file), 1200);
  writeFileSync(path.join(dir, 'junk.safetensors'), 'not a header');
  assert.equal(readHeaderStep(path.join(dir, 'junk.safetensors')), null);
  assert.equal(readHeaderStep(path.join(dir, 'missing.safetensors')), null);
}));

test('a checkpoint linked to a forbidden target is not opened', scratch((dir, t) => {
  mkdirSync(path.join(dir, '_Archive'));
  const target = path.join(dir, '_Archive', 'real.safetensors');
  writeSafetensors(target, { step: 999 });
  const link = path.join(dir, 'link_000000100.safetensors');
  try {
    symlinkSync(target, link);
  } catch {
    t.skip('this OS refused the symlink');
    return;
  }
  assert.equal(readHeaderStep(link), null);
}));

test('forbidden loss logs are refused, and a promoted folder falls back to its run', scratch(dir => {
  const archive = path.join(dir, '_Archive', 'old');
  mkdirSync(archive, { recursive: true });
  writeFileSync(path.join(archive, 'loss_log.db'), '');
  assert.equal(findLossDb(archive, path.join(dir, 'nothing')), null);

  const training = path.join(dir, 'runs');
  mkdirSync(path.join(training, 'sample'), { recursive: true });
  mkdirSync(path.join(dir, 'trained', 'sample'), { recursive: true });
  writeFileSync(path.join(training, 'sample', 'loss_log.db'), '');
  assert.equal(findLossDb(path.join(dir, 'trained', 'sample'), training), path.join(training, 'sample', 'loss_log.db'));
}));

test('a real log file drives the response, and a loosely named loss key is found', scratch(async dir => {
  const run = path.join(dir, 'sample');
  mkdirSync(run);
  for (const c of every300) writeSafetensors(path.join(run, c.file), { step: c.step });
  const { steps, values } = decayLog();
  await writeLossDb(path.join(run, 'loss_log.db'), 'my_Loss_value', steps, values);
  const res = await loadCandidates(run, dir);
  assert.equal(res.lossAvailable, true);
  assert.equal(res.lossKey, 'my_Loss_value');
  assert.equal(res.interval, 300);
  assert.equal(res.window, 300);
  assert.equal(res.checkpoints.length, every300.length);
  assert.ok(res.checkpoints.every(c => c.stepSource === 'metadata'));
  assert.ok(res.sparkline.steps.length <= 301);
  assert.equal(res.sparkline.steps[res.sparkline.steps.length - 1], 3000);
  assert.equal(res.sparkline.steps.length, res.sparkline.values.length);
}));

test('no log or an unreadable log means no loss data, with every checkpoint still listed', scratch(async dir => {
  const run = path.join(dir, 'sample');
  mkdirSync(run);
  writeFileSync(path.join(run, 'r_000000100.safetensors'), '');
  const none = await loadCandidates(run, dir);
  assert.equal(none.lossAvailable, false);
  assert.equal(none.lossKey, null);
  assert.equal(none.checkpoints.length, 1);
  assert.equal(none.checkpoints[0].stepSource, 'filename');
  assert.equal(none.checkpoints[0].score, null);
  assert.equal(none.checkpoints[0].recommended, false);

  writeFileSync(path.join(run, 'loss_log.db'), 'this is not a database, not even close');
  assert.equal((await loadCandidates(run, dir)).lossAvailable, false);

  rmSync(path.join(run, 'loss_log.db'));
  await writeLossDb(path.join(run, 'loss_log.db'), 'learning_rate', [1, 2], [0.1, 0.1]);
  const noKey = await loadCandidates(run, dir);
  assert.equal(noKey.lossAvailable, false);
  assert.equal(noKey.lossKey, null);
}));
