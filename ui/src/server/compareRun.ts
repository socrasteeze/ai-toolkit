// Fork-only (see FORK_NOTES.md). Checkpoint Compare's render loop: one job at a time against
// the resident inference engine, so the base stays loaded and only the hook LoRA changes.
// In process memory like datasetTools.ts: a UI restart forgets the job, the cached files stay.
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { resolvePythonPath } from '../../cron/pythonPath';
import { TOOLKIT_ROOT } from '../../cron/paths';
import { readEngineFrames } from '../utils/engineStream';
import { compareDir, isUnder, type PlanItem, type RunInfo } from './compare';
import type { EngineEndpoint } from './inferenceEngine';

export interface CompareJob {
  runName: string;
  status: 'running' | 'done' | 'cancelled' | 'error';
  total: number;
  done: number;
  message: string;
  error: string | null;
  cancelRequested: boolean;
  requestId: string | null;
  endpoint: EngineEndpoint;
}

let job: CompareJob | null = null;

// the engine token stays on the server
const publicJob = ({ endpoint: _endpoint, ...rest }: CompareJob) => rest;

export const getJob = (runName: string) => (job?.runName === runName ? publicJob(job) : null);

const engineFetch = (ep: EngineEndpoint, route: string, init?: RequestInit) =>
  fetch(`http://${ep.host}:${ep.port}/${route}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-engine-token': ep.token },
  });

const renderOne = async (info: RunInfo, item: PlanItem, ep: EngineEndpoint, current: CompareJob) => {
  const res = await engineFetch(ep, 'generate', {
    method: 'POST',
    body: JSON.stringify({
      // identical model block every time: the engine reloads only when this changes
      model: {
        ...info.model,
        loras: item.loraPath ? [{ path: item.loraPath, name: item.label, strength: 1.0 }] : [],
        lora_mode: 'hook',
      },
      sample: {
        prompt: item.params.prompt,
        negative_prompt: item.params.neg,
        seed: item.params.seed,
        width: item.params.width,
        height: item.params.height,
        num_inference_steps: item.params.steps,
        guidance_scale: item.params.cfg,
      },
      stream: { latents: 'none' },
    }),
  });
  if (!res.ok) throw new Error((await res.text()) || `Engine returned ${res.status}`);
  current.requestId = res.headers.get('x-request-id');
  let resultPath: string | null = null;
  let failure: string | null = null;
  await readEngineFrames(res, ({ header }) => {
    if (header.type === 'status') current.message = header.message;
    if (header.type === 'progress') current.message = `${item.label}: step ${header.step}/${header.total ?? '?'}`;
    if (header.type === 'result') resultPath = header.path;
    if (header.type === 'error' && !header.cancelled) failure = header.message;
  });
  current.requestId = null;
  if (failure) throw new Error(failure);
  if (!resultPath) return false; // cancelled

  const dir = compareDir(info.runName);
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, item.key);
  await fs.promises.copyFile(resultPath, `${dest}.part`);
  await fs.promises.rename(`${dest}.part`, dest);
  // the engine's copy was only a stopover; its request folder holds this one render
  const requestDir = path.dirname(resultPath);
  if (isUnder(requestDir, ep.output_folder)) await fs.promises.rm(requestDir, { recursive: true, force: true });
  return true;
};

const scoresPath = (runName: string) => path.join(compareDir(runName), 'scores.json');
export type Scores = Record<string, { score: number; method: string }>;

export const readScores = (runName: string): Scores => {
  try {
    return JSON.parse(fs.readFileSync(scoresPath(runName), 'utf-8'));
  } catch {
    return {};
  }
};

export const scoreKey = (itemKey: string, reference: string) => {
  const { mtimeMs } = fs.statSync(reference);
  const ref = crypto.createHash('sha1').update(`${reference}|${mtimeMs}`).digest('hex').slice(0, 12);
  return `${itemKey}|${ref}`;
};

const runScorer = (reference: string, images: string[]) =>
  new Promise<{ method: string; scores: Record<string, number> }>((resolve, reject) => {
    const script = path.join(TOOLKIT_ROOT, 'scripts', 'compare_likeness.py');
    const child = spawn(resolvePythonPath(), ['-u', script], {
      cwd: TOOLKIT_ROOT,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err = (err + d).slice(-2000)));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `Scorer exited with ${code}`));
      resolve(JSON.parse(out.trim().split('\n').pop() as string));
    });
    child.stdin.end(JSON.stringify({ reference, images }));
  });

const scoreRendered = async (info: RunInfo, items: PlanItem[], reference: string, current: CompareJob) => {
  const dir = compareDir(info.runName);
  const scores = readScores(info.runName);
  const missing = items.filter(i => !scores[scoreKey(i.key, reference)] && fs.existsSync(path.join(dir, i.key)));
  if (!missing.length) return;
  current.message = `Scoring ${missing.length} renders`;
  const result = await runScorer(
    reference,
    missing.map(i => path.join(dir, i.key)),
  );
  for (const item of missing) {
    const score = result.scores[path.join(dir, item.key)];
    if (typeof score === 'number') scores[scoreKey(item.key, reference)] = { score, method: result.method };
  }
  await fs.promises.writeFile(scoresPath(info.runName), JSON.stringify(scores, null, 1));
};

export const startRender = (info: RunInfo, items: PlanItem[], reference: string, endpoint: EngineEndpoint) => {
  if (job?.status === 'running') throw new Error('A compare render is already running.');
  const dir = compareDir(info.runName);
  const todo = items.filter(i => !fs.existsSync(path.join(dir, i.key)));
  const current: CompareJob = {
    runName: info.runName,
    status: 'running',
    total: todo.length,
    done: 0,
    message: 'Starting',
    error: null,
    cancelRequested: false,
    requestId: null,
    endpoint,
  };
  job = current;
  (async () => {
    for (const item of todo) {
      if (current.cancelRequested) break;
      if (await renderOne(info, item, endpoint, current)) current.done++;
    }
    // what finished before a cancel is still worth scoring
    await scoreRendered(info, items, reference, current);
    current.status = current.cancelRequested ? 'cancelled' : 'done';
    current.message = current.status === 'done' ? 'Done' : 'Cancelled';
  })().catch(e => {
    current.status = 'error';
    current.error = e?.message || String(e);
  });
  return publicJob(current);
};

export const cancelRender = async (runName: string) => {
  if (job?.runName !== runName || job.status !== 'running') return false;
  job.cancelRequested = true;
  job.message = 'Cancelling';
  if (job.requestId) await engineFetch(job.endpoint, `cancel/${job.requestId}`, { method: 'POST' }).catch(() => {});
  return true;
};
