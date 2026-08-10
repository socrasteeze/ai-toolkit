import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertDownloadedSize,
  attemptStopAcknowledgement,
  downloadAndReplaceFile,
  reconcileRemoteManifest,
  removedManifestFiles,
  sanitizePeerFilenames,
  shouldSkipExistingDownload,
  stagedDatasetName,
  temporaryDownloadPath,
} from '../cron/remoteIntegrity.ts';

test('staged dataset identity cannot alias sanitized job names', () => {
  const first = stagedDatasetName('a b', 'job-1', 0);
  const second = stagedDatasetName('a_b', 'job-2', 0);

  assert.notEqual(first.toLowerCase(), second.toLowerCase());
  assert.equal(first, stagedDatasetName('a b', 'job-1', 0));
  assert.match(first, /^hub_a_b_[0-9a-f]{24}_0$/);
  assert.throws(() => stagedDatasetName('job', '', 0), /stable job id/);
});

test('peer filename sanitization rejects punctuation collisions on every peer', () => {
  for (const options of [undefined, { rejectCaseCollisions: false }]) {
    assert.throws(
      () => sanitizePeerFilenames(['portrait one.png', 'portrait_one.png'], options),
      /collide on the peer/,
    );
  }
  assert.deepEqual(
    sanitizePeerFilenames(['portrait one.png', 'portrait-one.txt']),
    ['portrait_one.png', 'portrait-one.txt'],
  );
});

test('case-only collisions are fatal by default and allowed on a case-sensitive peer', () => {
  assert.throws(
    () => sanitizePeerFilenames(['Portrait.PNG', 'portrait.png']),
    /differ only in capitalization/,
  );
  assert.deepEqual(
    sanitizePeerFilenames(['Portrait.PNG', 'portrait.png'], { rejectCaseCollisions: false }),
    ['Portrait.PNG', 'portrait.png'],
  );
});

test('removed manifest detection returns only files absent locally', () => {
  assert.deepEqual(
    removedManifestFiles(
      { 'keep.png': '10:1', 'removed.txt': '20:2', 'also-removed.png': '30:3' },
      { 'keep.png': '10:1', 'added.png': '40:4' },
    ),
    ['removed.txt', 'also-removed.png'],
  );
});

test('untrusted and stale manifests reset before their contents are reused', async () => {
  const reasons = [];
  const reset = async reason => reasons.push(reason);

  assert.deepEqual(await reconcileRemoteManifest({ kind: 'untrusted' }, { 'new.png': '1:1' }, reset), {});
  assert.deepEqual(reasons.shift(), { kind: 'untrusted' });

  assert.deepEqual(
    await reconcileRemoteManifest({ kind: 'ok', manifest: { 'old.png': '1:1' } }, { 'new.png': '2:2' }, reset),
    {},
  );
  assert.deepEqual(reasons.shift(), { kind: 'removed', removed: ['old.png'] });

  const trusted = { 'keep.png': '3:3' };
  assert.equal(await reconcileRemoteManifest({ kind: 'ok', manifest: trusted }, trusted, reset), trusted);
  assert.deepEqual(reasons, []);
});

test('an unreachable peer re-sends everything but never authorizes a reset', async () => {
  const reasons = [];
  const reset = async reason => reasons.push(reason);

  // A 20-second timeout says nothing about what is staged. Deleting the peer's
  // dataset on that evidence throws away a multi-gigabyte upload for a blip.
  assert.deepEqual(await reconcileRemoteManifest({ kind: 'unavailable' }, { 'a.png': '1:1' }, reset), {});
  assert.deepEqual(reasons, []);
});

test('a rejected stop remains unacknowledged and the next attempt can succeed', async () => {
  let attempts = 0;
  const send = async () => {
    attempts++;
    if (attempts === 1) throw new Error('timeout');
  };

  const first = await attemptStopAcknowledgement(false, send);
  assert.equal(first.acknowledged, false);
  assert.match(first.error.message, /timeout/);

  const second = await attemptStopAcknowledgement(first.acknowledged, send);
  assert.deepEqual(second, { acknowledged: true });
  assert.equal(attempts, 2);

  assert.deepEqual(await attemptStopAcknowledgement(second.acknowledged, send), { acknowledged: true });
  assert.equal(attempts, 2);
});

test('download size validation rejects valid mismatches and ignores invalid reports', () => {
  assert.doesNotThrow(() => assertDownloadedSize('weights.safetensors', 1024, 1024));
  assert.throws(
    () => assertDownloadedSize('weights.safetensors', 1023, 1024),
    /1023 bytes; the peer reported 1024 bytes/,
  );
  assert.doesNotThrow(() => assertDownloadedSize('weights.safetensors', 1024, undefined));
  assert.doesNotThrow(() => assertDownloadedSize('weights.safetensors', 1024, -1));
  assert.doesNotThrow(() => assertDownloadedSize('weights.safetensors', 1024, 1.5));
});

test('a checkpoint we already hold at the reported size is not fetched again', () => {
  assert.equal(shouldSkipExistingDownload(1024, 1024), true);
  assert.equal(shouldSkipExistingDownload(null, 1024), false);
  // A truncated earlier copy must be replaced, not trusted.
  assert.equal(shouldSkipExistingDownload(512, 1024), false);
  // No usable size from the peer falls back to "we have the file, keep it",
  // which is what every re-queued job relied on before sizes were reported.
  assert.equal(shouldSkipExistingDownload(512, undefined), true);
  assert.equal(shouldSkipExistingDownload(512, -1), true);
  assert.equal(shouldSkipExistingDownload(512, 1.5), true);
});

test('the download temporary path is stable so an interrupted transfer can resume', () => {
  const destination = path.join('/models', 'weights.safetensors');

  // peerDownloadFile resumes from `${downloadPath}.part`, which only works if
  // the next invocation asks for the same path. A PID or UUID in here silently
  // restarts every multi-gigabyte transfer after a cron worker restart.
  assert.equal(temporaryDownloadPath(destination), temporaryDownloadPath(destination));
  assert.notEqual(temporaryDownloadPath(destination), temporaryDownloadPath(path.join('/models', 'other.safetensors')));
  assert.equal(path.dirname(temporaryDownloadPath(destination)), path.dirname(destination));
  assert.notEqual(temporaryDownloadPath(destination), destination);
});

test('an interrupted transfer keeps its resumable part file', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-toolkit-checkpoint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'weights.safetensors');

  await assert.rejects(
    downloadAndReplaceFile(destination, 4096, async temporary => {
      await fs.writeFile(`${temporary}.part`, 'partial');
      throw new Error('connection reset');
    }),
    /connection reset/,
  );

  // The bytes already on disk are what the next attempt resumes from.
  assert.equal(await fs.readFile(`${temporaryDownloadPath(destination)}.part`, 'utf8'), 'partial');
});

test('verified downloads atomically replace an existing file from a same-directory temporary', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-toolkit-checkpoint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'weights.safetensors');
  await fs.writeFile(destination, 'old');

  let temporaryDestination;
  await downloadAndReplaceFile(destination, 3, async temporary => {
    temporaryDestination = temporary;
    assert.equal(path.dirname(temporary), directory);
    assert.notEqual(temporary, destination);
    await fs.writeFile(temporary, 'new');
    return 3;
  });

  assert.equal(await fs.readFile(destination, 'utf8'), 'new');
  await assert.rejects(fs.stat(temporaryDestination), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${temporaryDestination}.part`), { code: 'ENOENT' });
});

test('a long valid checkpoint name still uses a compact temporary component', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-toolkit-checkpoint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, `${'w'.repeat(190)}.safetensors`);
  await fs.writeFile(destination, 'old');

  let temporaryDestination;
  await downloadAndReplaceFile(destination, 3, async temporary => {
    temporaryDestination = temporary;
    assert.equal(path.dirname(temporary), directory);
    assert.ok(path.basename(temporary).length < 100);
    await fs.writeFile(temporary, 'new');
    return 3;
  });

  assert.equal(await fs.readFile(destination, 'utf8'), 'new');
  await assert.rejects(fs.stat(temporaryDestination), { code: 'ENOENT' });
});

test('failed checkpoint verification preserves the old file and cleans temporary artifacts', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-toolkit-checkpoint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'weights.safetensors');
  await fs.writeFile(destination, 'old');

  let temporaryDestination;
  await assert.rejects(
    downloadAndReplaceFile(destination, 4, async temporary => {
      temporaryDestination = temporary;
      await fs.writeFile(temporary, 'new');
      await fs.writeFile(`${temporary}.part`, 'partial');
      return 3;
    }),
    /peer reported 4 bytes/,
  );

  assert.equal(await fs.readFile(destination, 'utf8'), 'old');
  await assert.rejects(fs.stat(temporaryDestination), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${temporaryDestination}.part`), { code: 'ENOENT' });
});

test('temporary cleanup retries Windows sharing failures without masking the transfer error', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-toolkit-checkpoint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'weights.safetensors');
  await fs.writeFile(destination, 'old');

  const attempts = new Map();
  let temporaryDestination;
  await assert.rejects(
    downloadAndReplaceFile(
      destination,
      4,
      async temporary => {
        temporaryDestination = temporary;
        await fs.writeFile(temporary, 'new');
        await fs.writeFile(`${temporary}.part`, 'partial');
        return 3;
      },
      {
        remove: async temporary => {
          const attempt = (attempts.get(temporary) ?? 0) + 1;
          attempts.set(temporary, attempt);
          if (attempt === 1) {
            const error = new Error('file is temporarily busy');
            error.code = 'EPERM';
            throw error;
          }
          await fs.rm(temporary, { force: true });
        },
        wait: async () => {},
      },
    ),
    /peer reported 4 bytes/,
  );

  assert.equal(await fs.readFile(destination, 'utf8'), 'old');
  assert.equal(attempts.get(temporaryDestination), 2);
  assert.equal(attempts.get(`${temporaryDestination}.part`), 2);
  await assert.rejects(fs.stat(temporaryDestination), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${temporaryDestination}.part`), { code: 'ENOENT' });
});

test('persistent cleanup failures are reported without replacing the primary error', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-toolkit-checkpoint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'weights.safetensors');
  await fs.writeFile(destination, 'old');

  let reported;
  let thrown;
  try {
    await downloadAndReplaceFile(
      destination,
      4,
      async temporary => {
        await fs.writeFile(temporary, 'new');
        await fs.writeFile(`${temporary}.part`, 'partial');
        return 3;
      },
      {
        remove: async () => {
          const error = new Error('file remains busy');
          error.code = 'EBUSY';
          throw error;
        },
        wait: async () => {},
        reportCleanupError: error => {
          reported = error;
        },
      },
    );
  } catch (error) {
    thrown = error;
  }

  assert.match(thrown.message, /peer reported 4 bytes/);
  assert.equal(thrown.cleanupError, reported);
  assert.match(reported.message, /Could not remove 2 remote-checkpoint temporary files/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'old');
});
