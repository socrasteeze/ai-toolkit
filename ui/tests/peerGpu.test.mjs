import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function load(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(
    name => {
      if (name === '@/utils/gpuIds') return gpuIds;
      throw new Error(`Unexpected import: ${name}`);
    },
    module,
    module.exports,
  );
  return module.exports;
}

const gpuIds = load('../src/utils/gpuIds.ts');
const { smiNumber } = load('../src/server/smiNumber.ts');
const { coerceGpuInfo, peerGpuCards, peerGpuForIds } = load('../src/utils/peerGpu.ts');

test('nvidia-smi missing sensors are null and a real zero is kept', () => {
  assert.equal(smiNumber('36'), 36);
  assert.equal(smiNumber('0'), 0);
  assert.equal(smiNumber('23.43', true), 23.43);
  assert.equal(smiNumber('[N/A]'), null);
  assert.equal(smiNumber('N/A', true), null);
  assert.equal(smiNumber('[Not Supported]'), null);
  assert.equal(smiNumber(''), null);
  assert.equal(smiNumber(undefined), null);
});

test('peer cards keep every reported field and dash the rest', () => {
  const [card] = peerGpuCards([
    {
      id: 'g18',
      label: 'NOBLE-G18 Laptop',
      online: true,
      gpus: [{ index: 0, name: 'RTX 5080 Laptop', temperature: 36, utilization: { gpu: 0 }, memory: { used: 294, total: 16303 }, power: { draw: 23.43, limit: null }, clocks: { graphics: 1492 }, fan: { speed: null } }],
    },
    { id: 'off', label: 'Off', online: false, gpus: [{ index: 0, name: 'Hidden' }] },
  ]);
  assert.equal(card.key, 'g18:0');
  assert.equal(card.label, 'NOBLE-G18 Laptop');
  assert.equal(card.gpu.temperature, 36);
  assert.equal(card.gpu.utilization.gpu, 0);
  assert.equal(card.gpu.memory.used, 294);
  assert.equal(card.gpu.power.draw, 23.43);
  assert.equal(card.gpu.power.limit, null);
  assert.equal(card.gpu.clocks.graphics, 1492);
  assert.equal(card.gpu.clocks.memory, null);
  assert.equal(card.gpu.fan.speed, null);
  assert.equal(peerGpuForIds('g18:0', [{ id: 'g18', label: 'NOBLE-G18 Laptop', online: true, gpus: [{ index: 0, temperature: 36 }] }]).gpu.temperature, 36);
  assert.equal(peerGpuForIds('g18:0', [{ id: 'g18', label: 'NOBLE-G18 Laptop', online: false, gpus: [{ index: 0 }] }]), null);
  assert.equal(coerceGpuInfo({}, 3).index, 3);
  assert.equal(coerceGpuInfo({}, 3).temperature, null);
});
