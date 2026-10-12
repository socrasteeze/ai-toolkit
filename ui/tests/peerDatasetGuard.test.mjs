import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPeerDatasetsSupported, PEER_SINGLE_FOLDER_ERROR } from '../cron/actions/peerDatasetGuard.ts';

test('peer jobs accept a single folder_path string', () => {
  assert.doesNotThrow(() => assertPeerDatasetsSupported([{ folder_path: 'D:/data/a' }, { folder_path: 'D:/data/b' }]));
  assert.doesNotThrow(() => assertPeerDatasetsSupported([{ folder_path: 'D:/data/a', dataset_path: '' }]));
  assert.doesNotThrow(() => assertPeerDatasetsSupported(undefined));
});

test('peer jobs refuse a list-valued folder_path', () => {
  assert.throws(
    () => assertPeerDatasetsSupported([{ folder_path: ['D:/data/a', 'D:/data/b'] }]),
    e => e.message.includes('folder_path') && e.message.includes(PEER_SINGLE_FOLDER_ERROR) && /locally/.test(e.message),
  );
});

test('peer jobs refuse any dataset_path', () => {
  for (const dp of ['D:/data/pool', ['D:/data/a', 'D:/data/b']]) {
    assert.throws(
      () => assertPeerDatasetsSupported([{ folder_path: 'D:/data/a' }, { dataset_path: dp }]),
      e => e.message.startsWith('Dataset 2 uses dataset_path') && e.message.includes('single dataset folder'),
    );
  }
});
