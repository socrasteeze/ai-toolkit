import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  findCaseInsensitiveNameCollision,
  resolveDatasetPath,
  sanitizeDatasetName,
} from '../src/server/datasetPath.ts';

test('accepts valid single-component dataset names unchanged', () => {
  for (const name of ['cats', 'my dataset', 'dataset.v2', '_controls']) {
    assert.equal(sanitizeDatasetName(name), name);
  }
});

test('rejects empty, dot, dotdot, and either path separator', () => {
  for (const name of [undefined, null, '', '   ', '.', '..', '/absolute', '\\absolute', 'a/b', 'a\\b']) {
    assert.equal(sanitizeDatasetName(name), null);
  }
});

test('resolves valid names strictly below the dataset root', () => {
  const root = path.resolve('test-data', 'datasets');
  assert.equal(resolveDatasetPath(root, 'cats'), path.resolve(root, 'cats'));
  const volumeRoot = path.parse(root).root;
  assert.equal(resolveDatasetPath(volumeRoot, 'cats'), path.resolve(volumeRoot, 'cats'));

  for (const name of ['', '.', '..', '../sibling', '..\\sibling', 'nested/child', 'nested\\child']) {
    assert.equal(resolveDatasetPath(root, name), null);
  }
});

test('detects duplicate sanitized destinations before upload', () => {
  assert.deepEqual(findCaseInsensitiveNameCollision(['a_b.png', 'a_b.png']), ['a_b.png', 'a_b.png']);
  assert.deepEqual(findCaseInsensitiveNameCollision(['Foo.png', 'foo.png']), ['Foo.png', 'foo.png']);
  assert.equal(findCaseInsensitiveNameCollision(['image.png', 'image.txt']), null);
});
