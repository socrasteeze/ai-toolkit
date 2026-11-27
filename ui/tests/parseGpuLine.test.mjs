import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function load(relativePath, requireImpl) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(requireImpl, module, module.exports);
  return module.exports;
}

const { smiNumber } = load('../src/server/smiNumber.ts', () => {
  throw new Error('smiNumber has no imports');
});
const { parseGpuLine, gpuSensorsBlank } = load('../src/server/parseGpuLine.ts', name => {
  if (name === '@/server/smiNumber') return { smiNumber };
  throw new Error(`Unexpected import: ${name}`);
});

const LIVE = '0, NVIDIA GeForce RTX 5090, 621.40, 65.19, 100, 29, 32607, 10077, 22114, 499.88, 575.00, 2805, 13801, 70';
const LIVE_TIGHT = '0,NVIDIA GeForce RTX 5090,621.40,65.19,100,29,32607,10077,22114,499.88,575.00,2805,13801,70';
const BLANK = '0, NVIDIA GeForce RTX 5090, 621.24, [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A]';

test('parseGpuLine keeps a live 5090 row, including float temperature and power', () => {
  for (const line of [LIVE, LIVE_TIGHT]) {
    const gpu = parseGpuLine(line);
    assert.equal(gpu.index, 0);
    assert.equal(gpu.name, 'NVIDIA GeForce RTX 5090');
    assert.equal(gpu.driverVersion, '621.40');
    assert.equal(gpu.temperature, 65);
    assert.equal(gpu.utilization.gpu, 100);
    assert.equal(gpu.utilization.memory, 29);
    assert.equal(gpu.memory.used, 22114);
    assert.equal(gpu.memory.total, 32607);
    assert.equal(gpu.power.draw, 499.88);
    assert.equal(gpu.power.limit, 575);
    assert.equal(gpu.clocks.graphics, 2805);
    assert.equal(gpu.clocks.memory, 13801);
    assert.equal(gpu.fan.speed, 70);
    assert.equal(gpuSensorsBlank(gpu), false);
  }
});

test('a fractional temperature rounds, and a name-only row is blank', () => {
  const rounded = parseGpuLine('0, NVIDIA GeForce RTX 5090, 621.40, 65.6, 0, 0, 1, 1, 0, 1.5, 575, 0, 0, 0');
  assert.equal(rounded.temperature, 66);
  assert.equal(gpuSensorsBlank(rounded), false);

  const blank = parseGpuLine(BLANK);
  assert.equal(blank.name, 'NVIDIA GeForce RTX 5090');
  assert.equal(blank.driverVersion, '621.24');
  assert.equal(blank.temperature, null);
  assert.equal(blank.power.draw, null);
  assert.equal(blank.power.limit, null);
  assert.equal(blank.fan.speed, null);
  assert.equal(gpuSensorsBlank(blank), true);
  assert.equal(parseGpuLine('not-a-gpu'), null);
});

test('a named power-limit fallback does not hide a blank unified GPU', () => {
  const blank = parseGpuLine('0, NVIDIA GB10, 570.00, [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A]');
  assert.equal(blank.power.limit, 140);
  assert.equal(gpuSensorsBlank(blank), true);

  const live = parseGpuLine('0, NVIDIA GB10, 570.00, 40, 10, 0, [N/A], [N/A], [N/A], 30.5, [N/A], 800, 1000, [N/A]');
  assert.equal(live.temperature, 40);
  assert.equal(live.power.limit, 140);
  assert.equal(live.fan.speed, null);
  assert.equal(gpuSensorsBlank(live), false);
});
