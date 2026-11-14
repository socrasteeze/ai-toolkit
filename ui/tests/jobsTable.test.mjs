// Exercise the real components with invented jobs and inert hooks. No server, API, or database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(relativePath, imports) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(
    name => {
      if (name in imports) return imports[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Unexpected import: ${name}`);
    },
    module,
    module.exports,
  );
  return module.exports;
}

const jobUtils = load('../src/utils/jobs.ts', { '@/utils/api': {} });
const gpuUtils = load('../src/utils/gpuIds.ts', {});
const Table = () => null;
const Filter = () => null;
const noop = () => {};
const gpu = { index: 0, name: 'Test GPU' };
const job = (id, status, gpu_ids = '0', step = 749) => ({
  id, name: id, status, gpu_ids, step, job_type: 'train', total_steps: null,
  job_config: JSON.stringify({ config: { process: [{ train: { steps: 750 } }] } }),
  queue_position: 1, updated_at: '2026-01-01T00:00:00Z',
});

function elements(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(child => elements(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}

function text(tree) {
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join('');
  return text(tree.props?.children);
}

function harness(allJobs, filter = '') {
  const state = { allJobs, filter, gpuList: [gpu], loaded: true, confirmations: [], deleted: [], stopped: [] };
  const values = [];
  const memos = [];
  let stateCursor = 0;
  let memoCursor = 0;
  const hooks = {
    useState(initial) {
      const index = stateCursor++;
      if (!(index in values)) values[index] = initial;
      return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
    },
    useMemo(fn, deps) {
      const index = memoCursor++;
      if (!memos[index] || deps.some((dep, i) => !Object.is(dep, memos[index].deps[i]))) {
        memos[index] = { deps, value: fn() };
      }
      return memos[index].value;
    },
    useEffect: noop,
    useRef: () => ({ current: null }),
  };
  const imports = {
    react: hooks,
    'next/link': { default: noop },
    '@/components/UniversalTable': { default: Table },
    './JobActionBar': { default: noop },
    '@/hooks/useJobsList': { default: () => ({ jobs: state.allJobs, status: 'success', refreshJobs: noop }) },
    '@/hooks/useQueueList': { default: () => ({ queues: [], status: 'success', refreshQueues: noop }) },
    '@/hooks/useGPUInfo': { default: () => ({ gpuList: state.gpuList, isGPUInfoLoaded: state.loaded }) },
    classnames: { default: () => '' },
    '@/utils/queue': {},
    'react-icons/cg': { CgSpinner: noop },
    'lucide-react': { Trash2: noop },
    '@/components/ConfirmModal': { openConfirm: options => state.confirmations.push(options) },
    '@/utils/jobs': {
      ...jobUtils,
      deleteJob: async id => state.deleted.push(id),
      stopJob: async id => state.stopped.push(id),
    },
    '@/utils/gpuIds': gpuUtils,
    './JobStatusFilter': { default: Filter, useJobStatusFilter: () => [state.filter, value => { state.filter = value; }] },
  };
  const JobsTable = load('../src/components/JobsTable.tsx', imports).default;
  state.render = (props = {}) => {
    stateCursor = memoCursor = 0;
    return JobsTable(props);
  };
  state.tables = tree => elements(tree, element => element.type === Table);
  state.rows = tree => state.tables(tree).flatMap(table => table.props.rows.map(row => row.id));
  state.button = (tree, label) => elements(tree, element => element.type === 'button' && text(element) === label)[0];
  state.overview = load('../src/components/JobOverview.tsx', {
    ...imports,
    '@/hooks/useCPUInfo': { default: () => ({ isCPUInfoLoaded: false }) },
    '@/components/GPUWidget': { default: noop },
    '@/components/CPUWidget': { default: noop },
    '@/components/FilesWidget': { default: noop },
    '@/hooks/useJobLog': { default: () => ({ log: '', status: 'success' }) },
    './jobLog.css': {},
  }).default;
  return state;
}

test('every status filter keeps local and remote active queues and filters only Idle', () => {
  const active = ['queued', 'running', 'stopping'].flatMap(status => [job(`local-${status}`, status), job(`remote-${status}`, status, 'peer:0')]);
  const idle = [job('done', 'completed'), job('stopped', 'stopped', 'retired:0'), job('error', 'error')];
  const h = harness([...active, ...idle]);
  for (const filter of ['', 'queued', 'running', 'stopping', 'stopped', 'completed', 'error']) {
    h.filter = filter;
    const tree = h.render();
    assert.deepEqual(new Set(h.rows(tree)), new Set([...active, ...idle.filter(row => !filter || row.status === filter)].map(row => row.id)));
    assert.doesNotMatch(text(tree), /retired .*GPU/);
    assert.match(text(tree), /peer .*GPU 0/);
    assert.equal(h.tables(tree).length, 3);
  }
});

test('remote queue disappears when its last active job becomes idle', () => {
  const h = harness([job('remote', 'queued', 'peer:0')]);
  assert.match(text(h.render()), /peer .*GPU/);
  h.allJobs = [job('remote', 'completed', 'peer:0')];
  const tree = h.render();
  assert.doesNotMatch(text(tree), /peer .*GPU/);
  assert.deepEqual(h.tables(tree).at(-1).props.rows.map(row => row.id), ['remote']);
});

test('GPU metadata and loading changes invalidate grouping', () => {
  const h = harness([job('queued', 'queued')]);
  h.loaded = false;
  assert.deepEqual(h.rows(h.render()), []);
  h.loaded = true;
  assert.match(text(h.render()), /Test GPU/);
  h.gpuList = [{ ...gpu, name: 'Updated GPU' }];
  assert.match(text(h.render()), /Updated GPU/);
});

test('select-all and mass delete use visible queues plus filtered Idle only', async () => {
  const h = harness([job('running', 'running'), job('remote', 'queued', 'peer:0'), job('visible', 'stopped'), job('hidden', 'completed')], 'stopped');
  let tree = h.render();
  h.tables(tree)[0].props.columns[0].title.props.onChange();
  tree = h.render();
  assert.equal(h.tables(tree)[0].props.columns[0].title.props.checked, true);
  h.button(tree, 'Delete Selected').props.onClick();
  await h.confirmations[0].onConfirm();
  assert.deepEqual(new Set(h.deleted), new Set(['running', 'remote', 'visible']));
  assert.deepEqual(h.stopped, ['running']);
});

test('stale selection cannot delete a row hidden after polling or select an unrendered Idle row', () => {
  const h = harness([job('selected', 'stopped')], 'stopped');
  let tree = h.render();
  h.tables(tree)[0].props.columns[0].title.props.onChange();
  h.allJobs = [job('selected', 'completed')];
  tree = h.render();
  h.button(tree, 'Delete Selected').props.onClick();
  assert.equal(h.confirmations.length, 0);
  h.gpuList = [];
  h.allJobs = [job('unmapped', 'running')];
  tree = h.render({ onlyActive: true });
  assert.deepEqual(h.rows(tree), []);
});

test('dashboard ignores the saved filter and does not render Idle', () => {
  const h = harness([job('active', 'queued'), job('idle', 'stopped')], 'completed');
  const tree = h.render({ onlyActive: true });
  assert.deepEqual(h.rows(tree), ['active']);
  assert.equal(elements(tree, element => element.type === Filter).length, 0);
});

test('list and overview render completed steps and a full bar without mutating the job', () => {
  const completed = Object.freeze(job('done', 'completed'));
  const h = harness([completed]);
  const table = h.tables(h.render()).at(-1);
  const cell = table.props.columns.find(column => column.key === 'steps').render(completed);
  assert.equal(text(cell), '750 / 750');
  assert.equal(elements(cell, element => element.props?.style?.width === '100%').length, 1);
  const overview = h.overview({ job: completed });
  assert.match(text(overview), /Step 750 of 750/);
  assert.equal(elements(overview, element => element.props?.style?.width === '100%').length, 1);
  assert.equal(completed.step, 749);
});
