import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listScopedDatasetFiles, parseDatasetScope } from '../src/server/datasetScope.ts';

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const writePng = async (root, relativePath, withCaption = false) => {
  const target = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, onePixelPng);
  if (withCaption) await fs.writeFile(target.replace(/\.png$/, '.txt'), 'caption');
};

test('dataset file walks honor loose-file and selected-child scope', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aitk-dataset-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writePng(root, 'loose.png', true);
  await writePng(root, 'Folder A/a.png', true);
  await writePng(root, 'Folder A/Nested/deep.png');
  await writePng(root, 'Folder B/b.png');
  await writePng(root, '.thumbs/thumb.png');
  await writePng(root, '_controls/control.png');

  const acceptsPng = name => name.endsWith('.png');
  const relative = async scope =>
    (await listScopedDatasetFiles(root, acceptsPng, scope))
      .map(file => path.relative(root, file).replaceAll('\\', '/'))
      .sort();

  assert.deepEqual(await relative(), ['Folder A/Nested/deep.png', 'Folder A/a.png', 'Folder B/b.png', 'loose.png']);
  assert.deepEqual(await relative({ includeLooseFiles: true, includeSubfolders: ['Folder A'] }), [
    'Folder A/Nested/deep.png',
    'Folder A/a.png',
    'loose.png',
  ]);
  assert.deepEqual(await relative({ includeLooseFiles: false, includeSubfolders: ['Folder B'] }), ['Folder B/b.png']);
  assert.deepEqual(await relative({ includeLooseFiles: true, includeSubfolders: [] }), ['loose.png']);
});

test('dataset scope parser preserves legacy recursion and rejects unsafe child names', () => {
  assert.deepEqual(parseDatasetScope(undefined, undefined), {
    includeLooseFiles: true,
    includeSubfolders: null,
  });
  assert.deepEqual(parseDatasetScope(false, ['Folder A', 'Folder A', ' Folder B ']), {
    includeLooseFiles: false,
    includeSubfolders: ['Folder A', ' Folder B '],
  });

  for (const value of ['Folder A', [''], ['..'], ['A/B'], ['A\\B'], [1]]) {
    assert.equal(parseDatasetScope(true, value), null);
  }
});
