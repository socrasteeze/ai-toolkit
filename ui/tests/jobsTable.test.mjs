// Exercise the real components with invented jobs and inert hooks. No server, API, or database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(relativePath, imports, storage) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'localStorage', outputText)(
    name => {
      if (name in imports) return imports[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Unexpected import: ${name}`);
    },
    module,
    module.exports,
    storage,
  );
  return module.exports;
}

const jobUtils = load('../src/utils/jobs.ts', { '@/utils/api': {} });
const gpuUtils = load('../src/utils/gpuIds.ts', {});
const viewUtils = load('../src/utils/jobListView.ts', {});
const Table = () => null;
const Filter = () => null;
const Search = () => null;
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

function harness(allJobs, filter = '', savedSort = null) {
  const state = { allJobs, filter, gpuList: [gpu], queues: [], loaded: true, confirmations: [], deleted: [], stopped: [], storage: new Map() };
  if (savedSort !== null) state.storage.set('aitk_jobs_name_sort', savedSort);
  const storage = {
    getItem: key => {
      if (state.storageBlocked) throw new Error('Storage unavailable');
      return state.storage.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (state.storageBlocked) throw new Error('Storage unavailable');
      state.storage.set(key, value);
    },
  };
  const values = [];
  const memos = [];
  const effects = [];
  const pendingEffects = [];
  let stateCursor = 0;
  let memoCursor = 0;
  let effectCursor = 0;
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
    useEffect(fn, deps) {
      const index = effectCursor++;
      if (!effects[index] || deps.some((dep, i) => !Object.is(dep, effects[index][i]))) {
        effects[index] = deps;
        pendingEffects.push(fn);
      }
    },
    useRef: () => ({ current: null }),
  };
  const imports = {
    react: hooks,
    'next/link': { default: noop },
    '@/components/UniversalTable': { default: Table },
    './JobActionBar': { default: noop },
    '@/hooks/useJobsList': { default: () => ({ jobs: state.allJobs, status: 'success', refreshJobs: noop }) },
    '@/hooks/useQueueList': { default: () => ({ queues: state.queues, status: 'success', refreshQueues: noop }) },
    '@/hooks/useGPUInfo': { default: () => ({ gpuList: state.gpuList, isGPUInfoLoaded: state.loaded }) },
    classnames: { default: () => '' },
    '@/utils/queue': {},
    'react-icons/cg': { CgSpinner: noop },
    'lucide-react': { Trash2: noop, ArrowUp: noop, ArrowDown: noop, ArrowUpDown: noop, ChevronDown: noop, ChevronRight: noop },
    '@/components/ConfirmModal': { openConfirm: options => state.confirmations.push(options) },
    '@/utils/jobs': {
      ...jobUtils,
      deleteJob: async id => state.deleted.push(id),
      stopJob: async id => state.stopped.push(id),
    },
    '@/utils/gpuIds': gpuUtils,
    '@/utils/jobListView': viewUtils,
    '@/hooks/useJobNameSort': load('../src/hooks/useJobNameSort.ts', { react: hooks, '@/utils/jobListView': viewUtils }, storage),
    '@/hooks/useCollapsedQueues': load('../src/hooks/useCollapsedQueues.ts', { react: hooks }, storage),
    './JobSearch': { default: Search },
    './JobStatusFilter': { default: Filter, useJobStatusFilter: () => [state.filter, value => { state.filter = value; }] },
  };
  const JobsTable = load('../src/components/JobsTable.tsx', imports).default;
  state.render = (props = {}) => {
    stateCursor = memoCursor = effectCursor = 0;
    const tree = JobsTable(props);
    pendingEffects.splice(0).forEach(effect => effect());
    return tree;
  };
  state.tables = tree => elements(tree, element => element.type === Table);
  state.rows = tree => state.tables(tree).flatMap(table => table.props.rows.map(row => row.id));
  state.button = (tree, label) => elements(tree, element => element.type === 'button' && text(element) === label)[0];
  state.search = (tree, value) => elements(tree, element => element.type === Search)[0].props.onChange(value);
  state.nameHeader = tree => state.tables(tree)[0].props.columns.find(column => column.key === 'name').title;
  state.overview = load('../src/components/JobOverview.tsx', {
    ...imports,
    '@/hooks/useCPUInfo': { default: () => ({ isCPUInfoLoaded: false }) },
    '@/hooks/usePeerMachines': { default: () => [] },
    '@/utils/peerGpu': { peerGpuForIds: () => null },
    '@/components/GPUWidget': { default: noop },
    '@/components/CPUWidget': { default: noop },
    '@/components/FilesWidget': { default: noop },
    '@/hooks/useJobLog': { default: () => ({ log: '', status: 'success' }) },
    './jobLog.css': {},
  }).default;
  return state;
}

test('queued rows show Job queued when info is a stale stopping message', () => {
  assert.equal(jobUtils.displayJobInfo({ status: 'queued', info: 'Stopping job...' }), 'Job queued');
  assert.equal(jobUtils.displayJobInfo({ status: 'queued', info: 'Stopping on peer…' }), 'Job queued');
  assert.equal(jobUtils.displayJobInfo({ status: 'running', info: 'Stopping job...' }), 'Stopping job...');
  assert.equal(jobUtils.displayJobInfo({ status: 'queued', info: 'Step 10' }), 'Step 10');
  const h = harness([job('queued', 'queued')]);
  const column = h.tables(h.render())[0].props.columns.find(item => item.key === 'info');
  assert.equal(column.render({ status: 'queued', info: 'Stopping job...' }), 'Job queued');
});

test('each queue collapses independently and remembers it', () => {
  const h = harness([job('run', 'running'), job('wait', 'queued'), job('peer', 'running', 'peer:0')]);
  h.queues = [{ gpu_ids: '0', is_running: true }, { gpu_ids: 'peer:0', is_running: false }];
  let tree = h.render();
  assert.equal(h.tables(tree).length, 3);
  const collapse = elements(tree, element => element.type === 'button' && text(element) === 'Collapse queue');
  assert.equal(collapse.length, 2);
  collapse[0].props.onClick();
  tree = h.render();
  assert.equal(h.tables(tree).length, 2);
  assert.match(text(tree), /1 running · 1 queued · 0 stopped · 0 error/);
  assert.equal(elements(tree, element => element.type === 'button' && text(element) === 'STOP').length, 1);
  assert.equal(elements(tree, element => element.type === 'button' && text(element) === 'START').length, 1);
  assert.equal(h.storage.get('aitk_queue_collapsed'), JSON.stringify({ '0': true }));
  h.render();
  tree = h.render();
  assert.equal(elements(tree, element => element.type === 'button' && text(element) === 'Expand queue').length, 1);
  assert.equal(h.tables(tree).length, 2);
});

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
  assert.equal(elements(tree, element => element.type === Search).length, 0);
});

test('search matches a case-insensitive name substring across queues and every Idle status', () => {
  const active = ['queued', 'running', 'stopping'].flatMap(status => [
    job(`local-ALPHA-${status}`, status), job(`remote-alpha-${status}`, status, 'peer:0'),
  ]);
  const idle = ['completed', 'stopped', 'error', 'other'].map(status => job(`idle-Alpha-${status}`, status));
  const h = harness([...active, ...idle, job('unmatched', 'running'), job('unmatched-idle', 'completed')]);
  h.search(h.render(), 'PhA');
  assert.deepEqual(new Set(h.rows(h.render())), new Set([...active, ...idle].map(row => row.id)));
  h.search(h.render(), '');
  assert.equal(h.rows(h.render()).length, active.length + idle.length + 2);
});

test('search combines with each status filter while status still narrows only Idle', () => {
  const active = ['queued', 'running', 'stopping'].flatMap(status => [
    job(`local-match-${status}`, status), job(`remote-match-${status}`, status, 'peer:0'),
  ]);
  const idle = ['completed', 'stopped', 'error'].map(status => job(`idle-match-${status}`, status));
  const h = harness([...active, ...idle, job('hidden', 'running'), job('hidden-idle', 'completed')]);
  h.search(h.render(), 'MATCH');
  for (const filter of ['', 'queued', 'running', 'stopping', 'completed', 'stopped', 'error']) {
    h.filter = filter;
    assert.deepEqual(new Set(h.rows(h.render())), new Set([
      ...active, ...idle.filter(row => !filter || row.status === filter),
    ].map(row => row.id)));
  }
});

test('a search with no matches keeps running queue STOP controls but creates no inactive peer section', () => {
  const h = harness([
    job('local-hidden', 'running'), job('remote-hidden', 'running', 'peer:0'),
    job('retired-hidden', 'completed', 'retired:0'),
  ]);
  h.queues = [{ gpu_ids: '0', is_running: true }, { gpu_ids: 'peer:0', is_running: true }];
  h.search(h.render(), 'no matches');
  const tree = h.render();
  assert.deepEqual(h.rows(tree), []);
  assert.match(text(tree), /Test GPU/);
  assert.match(text(tree), /peer .*GPU 0/);
  assert.doesNotMatch(text(tree), /retired .*GPU/);
  assert.equal(elements(tree, element => element.type === 'button' && text(element) === 'STOP').length, 2);
  assert.equal(h.tables(tree).length, 3);
  h.allJobs = h.allJobs.map(row => ({ ...row, status: 'completed' }));
  assert.doesNotMatch(text(h.render()), /peer .*GPU/);
});

test('select-all and mass delete cannot reach rows hidden by search or status', async () => {
  const h = harness([
    job('match-local', 'queued'), job('match-peer', 'queued', 'peer:0'), job('match-idle', 'stopped'),
    job('hidden-running', 'running'), job('match-wrong-status', 'completed'), job('hidden-idle', 'stopped'),
  ], 'stopped');
  h.search(h.render(), 'match');
  let tree = h.render();
  h.tables(tree)[0].props.columns[0].title.props.onChange();
  tree = h.render();
  assert.match(text(tree), /3 jobs selected/);
  h.button(tree, 'Delete Selected').props.onClick();
  await h.confirmations[0].onConfirm();
  assert.deepEqual(new Set(h.deleted), new Set(['match-local', 'match-peer', 'match-idle']));
  assert.deepEqual(h.stopped, []);
});

test('changing search clears selection and polling cannot delete a newly hidden selected row', async () => {
  const h = harness([job('match-first', 'stopped'), job('match-second', 'stopped')]);
  let tree = h.render();
  h.tables(tree)[0].props.columns[0].title.props.onChange();
  h.search(h.render(), 'match');
  tree = h.render();
  assert.equal(h.button(tree, 'Delete Selected'), undefined);
  h.tables(tree)[0].props.columns[0].title.props.onChange();
  h.allJobs = h.allJobs.map(row => row.id === 'match-second' ? { ...row, name: 'hidden after poll' } : row);
  tree = h.render();
  h.button(tree, 'Delete Selected').props.onClick();
  await h.confirmations[0].onConfirm();
  assert.deepEqual(h.deleted, ['match-first']);
});

test('Name header cycles default, A to Z, Z to A, default within every section', () => {
  const jobs = [
    ...['queue', 'peer', 'idle'].flatMap((section, i) => [
      { ...job(`${section}-10`, i === 2 ? 'completed' : 'queued', i === 1 ? 'peer:0' : '0'), name: 'beta10', queue_position: 2, updated_at: '2026-01-02' },
      { ...job(`${section}-2`, i === 2 ? 'completed' : 'queued', i === 1 ? 'peer:0' : '0'), name: 'BETA2', queue_position: 3, updated_at: '2026-01-01' },
      { ...job(`${section}-a`, i === 2 ? 'completed' : 'running', i === 1 ? 'peer:0' : '0'), name: 'alpha', queue_position: 1, updated_at: '2026-01-03' },
    ]),
  ];
  const before = JSON.stringify(jobs);
  const h = harness(jobs);
  const expectedOrders = [['a', '10', '2'], ['a', '2', '10'], ['10', '2', 'a'], ['a', '10', '2']];
  for (let i = 0; i < expectedOrders.length; i++) {
    const tree = h.render();
    assert.deepEqual(h.tables(tree).map(table => table.props.rows.map(row => row.id)),
      ['queue', 'peer', 'idle'].map(section => expectedOrders[i].map(suffix => `${section}-${suffix}`)));
    assert.match(text(h.nameHeader(tree)), [/Default order/, /A to Z/, /Z to A/, /Default order/][i]);
    if (i < 3) h.nameHeader(tree).props.onClick();
  }
  assert.equal(JSON.stringify(jobs), before);
});

test('name comparison ignores case and accents, sorts numbers, and preserves default order for ties', () => {
  const jobs = [{ name: 'café10' }, { name: 'CAFE2' }, { name: 'cafe2' }];
  assert.deepEqual(viewUtils.sortJobsByName(jobs, 'asc'), [jobs[1], jobs[2], jobs[0]]);
  assert.deepEqual(viewUtils.sortJobsByName(jobs, 'desc'), [jobs[0], jobs[1], jobs[2]]);
  assert.deepEqual(viewUtils.sortJobsByName(jobs, 'default'), jobs);
  assert.equal(viewUtils.matchesJobSearch({ name: 'Alpha Beta' }, 'HA b'), true);
  assert.equal(viewUtils.matchesJobSearch({ name: 'Alpha Beta' }, 'missing'), false);
});

test('name sort persists all three choices and restores them after mount', () => {
  const jobs = [job('zulu', 'queued'), job('alpha', 'queued')];
  const h = harness(jobs);
  for (const [sort, order] of [['asc', ['alpha', 'zulu']], ['desc', ['zulu', 'alpha']], ['default', ['zulu', 'alpha']]]) {
    h.nameHeader(h.render()).props.onClick();
    assert.equal(h.storage.get('aitk_jobs_name_sort'), sort);
    const restored = harness(jobs, '', sort);
    assert.deepEqual(restored.rows(restored.render()), ['zulu', 'alpha']);
    assert.deepEqual(restored.rows(restored.render()), order);
  }
});

test('invalid or blocked browser storage leaves sorting usable', () => {
  for (const blocked of [false, true]) {
    const h = harness([job('zulu', 'queued'), job('alpha', 'queued')], '', 'invalid');
    h.storageBlocked = blocked;
    h.render();
    assert.deepEqual(h.rows(h.render()), ['zulu', 'alpha']);
    h.nameHeader(h.render()).props.onClick();
    assert.deepEqual(h.rows(h.render()), ['alpha', 'zulu']);
  }
});

test('search control exposes a labelled input and an explicit clear button', () => {
  const JobSearch = load('../src/components/JobSearch.tsx', { 'lucide-react': { X: noop } }).default;
  const changes = [];
  let tree = JobSearch({ value: 'Alpha', onChange: value => changes.push(value) });
  const input = elements(tree, element => element.type === 'input')[0];
  assert.equal(input.props['aria-label'], 'Search Jobs');
  input.props.onChange({ target: { value: 'Beta' } });
  const clear = elements(tree, element => element.type === 'button')[0];
  assert.equal(clear.props['aria-label'], 'Clear Search');
  clear.props.onClick();
  assert.deepEqual(changes, ['Beta', '']);
  tree = JobSearch({ value: '', onChange: noop });
  assert.equal(elements(tree, element => element.type === 'button').length, 0);
});

test('the scrolling status picker keeps every status selectable and reports the active choice', () => {
  const JobStatusFilter = load('../src/components/JobStatusFilter.tsx', {
    react: {}, classnames: { default: require('classnames') },
  }).default;
  const statuses = ['', 'queued', 'running', 'stopping', 'completed', 'stopped', 'error'];
  for (const value of statuses) {
    const changes = [];
    const tree = JobStatusFilter({ value, onChange: status => changes.push(status) });
    const buttons = elements(tree, element => element.type === 'button');
    assert.deepEqual(buttons.map(text), ['All', ...statuses.slice(1)]);
    assert.deepEqual(buttons.map(button => button.props['aria-pressed']), statuses.map(status => status === value));
    buttons.forEach(button => button.props.onClick());
    assert.deepEqual(changes, statuses);
  }
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
