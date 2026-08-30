import assert from 'node:assert/strict';
import test from 'node:test';

import { createToolRunRegistry } from '../src/server/toolRunRegistry.ts';

/** A registry whose retention timers fire only when the test says so. */
function registryWithManualTimers() {
  const pending = [];
  const registry = createToolRunRegistry({
    retentionMs: 1000,
    setTimer: callback => pending.push(callback),
  });
  return { registry, fireRetention: () => pending.splice(0).forEach(callback => callback()) };
}

const makeRun = (runId, datasetName, status = 'running') => ({ runId, datasetName, status });

test('a finished run is still discoverable by its dataset', () => {
  const { registry } = registryWithManualTimers();
  const run = makeRun('caption-1', 'portraits');
  registry.register(run);

  run.status = 'done';
  registry.scheduleRetirement(run);

  // This is the regression: getActive backs GET ?datasetName=..., so dropping
  // the run here made reopening the modal show an empty panel rather than the
  // completed log.
  assert.equal(registry.getActive('portraits'), run);
  assert.equal(registry.get('caption-1'), run);
});

test('one writer per dataset while running, and the slot frees up once it is not', () => {
  const { registry } = registryWithManualTimers();
  const first = makeRun('prep-1', 'portraits');
  registry.register(first);

  // The caller's guard is `status === 'running'`, not mere presence — which is
  // why keeping a finished run registered does not block the next one.
  assert.equal(registry.getActive('portraits').status, 'running');

  first.status = 'failed';
  assert.notEqual(registry.getActive('portraits').status, 'running');

  const second = makeRun('prep-2', 'portraits');
  registry.register(second);
  assert.equal(registry.getActive('portraits'), second);
});

test('retention forgets a run from both lookups at once', () => {
  const { registry, fireRetention } = registryWithManualTimers();
  const run = makeRun('preflight-1', 'portraits', 'done');
  registry.register(run);
  registry.scheduleRetirement(run);

  fireRetention();

  assert.equal(registry.get('preflight-1'), undefined);
  assert.equal(registry.getActive('portraits'), undefined);
});

test('a prep run owns its output dataset too, and frees it with the source', () => {
  // The bug: the writer lock was keyed on the source only, so a prep writing
  // `portraits_prepped` did not stop a caption run from starting on `portraits_prepped`.
  const { registry, fireRetention } = registryWithManualTimers();
  const prep = { ...makeRun('prep-1', 'portraits'), locks: ['portraits_prepped'] };
  registry.register(prep);

  assert.equal(registry.findRunningWriter(['portraits_prepped']), prep);
  assert.equal(registry.findRunningWriter(['portraits']), prep);
  assert.equal(registry.findRunningWriter(['unrelated']), undefined);

  prep.status = 'done';
  assert.equal(registry.findRunningWriter(['portraits_prepped']), undefined);
  // still discoverable by either name until retention
  assert.equal(registry.getActive('portraits_prepped'), prep);

  registry.scheduleRetirement(prep);
  fireRetention();
  assert.equal(registry.getActive('portraits_prepped'), undefined);
  assert.equal(registry.getActive('portraits'), undefined);
});

test('running() lists only runs still in flight', () => {
  const { registry } = registryWithManualTimers();
  const a = makeRun('caption-1', 'a');
  const b = makeRun('caption-2', 'b', 'cancelled');
  registry.register(a);
  registry.register(b);
  assert.deepEqual(registry.running(), [a]);
});

test('a stale run retiring never evicts the run that replaced it', () => {
  const { registry, fireRetention } = registryWithManualTimers();
  const old = makeRun('caption-1', 'portraits', 'done');
  registry.register(old);
  registry.scheduleRetirement(old);

  const current = makeRun('caption-2', 'portraits');
  registry.register(current);

  fireRetention();

  assert.equal(registry.get('caption-1'), undefined);
  assert.equal(registry.getActive('portraits'), current);
  assert.equal(registry.get('caption-2'), current);
});
