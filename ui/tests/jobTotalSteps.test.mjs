// Contract test for getTotalSteps in ui/src/utils/jobs.ts. Fixtures use invented values only.
// jobs.ts imports '@/' aliases that bare Node cannot resolve, so its real source is transpiled here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/utils/jobs.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const jobs = {};
new Function('exports', 'require', outputText)(jobs, () => ({ apiClient: {} }));

const job_config = JSON.stringify({ config: { process: [{ train: { steps: 3000 } }] } });

test('a training job takes its length from the config, not a stale total_steps', () => {
  assert.equal(jobs.getTotalSteps({ job_type: 'train', total_steps: 2500, job_config }), 3000);
  assert.equal(jobs.getTotalSteps({ job_type: 'train', total_steps: null, job_config }), 3000);
});

test('a caption job keeps its file count', () => {
  assert.equal(jobs.getTotalSteps({ job_type: 'caption', total_steps: 42, job_config }), 42);
});
