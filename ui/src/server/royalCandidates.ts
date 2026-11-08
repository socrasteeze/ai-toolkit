// Fork-only (see FORK_NOTES.md). Checkpoint Compare's candidate picker: scores each save on how
// low and steady the loss was just before it. Loss only narrows the field; renders and CLIP decide.
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { isForbiddenPath, listCheckpoints } from './compare';

export const FRACTIONS = [0.5, 0.75, 1.0];

const MAX_HEADER_BYTES = 100 * 1024 * 1024;
const MIN_WINDOW_ROWS = 10;
// the final save lands one step past the last row and the logger buffers about 0.25 s
const LOG_TAIL_TOLERANCE = 5;
const SPARKLINE_POINTS = 300;
const NO_ROWS = 'no loss rows near this save';
const EARLY = 'early pick (at plateau onset)';

export interface CheckpointInput {
  file: string;
  step: number | null;
  stepSource: 'metadata' | 'filename' | null;
}

export interface CandidateRow extends CheckpointInput {
  score: number | null;
  reasons: string[];
  recommended: boolean;
  isFinal: boolean;
}

export interface ScoreResult {
  interval: number;
  window: number;
  plateauStep: number | null;
  ema: number[];
  checkpoints: CandidateRow[];
}

export interface CandidatesResponse {
  lossAvailable: boolean;
  lossKey: string | null;
  interval: number;
  window: number;
  plateauStep: number | null;
  sparkline: { steps: number[]; values: number[] };
  checkpoints: CandidateRow[];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const slope = (x: number[], y: number[]) => {
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i] - mx) * (y[i] - my);
    den += (x[i] - mx) ** 2;
  }
  return den ? num / den : 0;
};

// first index whose step is past x; steps are sorted and unique (primary key)
const upperBound = (steps: number[], x: number) => {
  let lo = 0;
  let hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

// same zero-phase EMA as JobLossGraph.tsx, which is client-only so cannot be imported here
const zeroPhaseEma = (values: number[], alpha: number) => {
  const pass = (v: number[]) => {
    let acc = 0;
    return v.map((y, i) => {
      acc = alpha * y + (1 - alpha) * acc;
      return acc / (1 - (1 - alpha) ** (i + 1));
    });
  };
  const n = values.length;
  const forward = pass(values);
  const backward = pass([...values].reverse()).reverse();
  const weight = (i: number) => 1 - (1 - alpha) ** (i + 1);
  return forward.map((f, i) => (weight(i) * f + weight(n - 1 - i) * backward[i]) / (weight(i) + weight(n - 1 - i)));
};

type Save = CheckpointInput & { step: number };
interface Scored {
  score: number;
  reasons: string[];
}

const scoreWindow = (
  cks: Save[],
  steps: number[],
  values: number[],
  ema: number[],
  W: number,
  f: number,
): { plateau: number | null; scores: Map<string, Scored> } => {
  const lastLogged = steps.length ? steps[steps.length - 1] : -Infinity;
  // a log written every N steps legitimately ends up to N steps before the final save
  const tailTolerance = Math.max(LOG_TAIL_TOLERANCE, median(steps.slice(1).map((s, i) => s - steps[i])));
  const stats = cks.flatMap(c => {
    if (c.step - lastLogged > tailTolerance) return [];
    const s = Math.min(c.step, lastLogged);
    const from = upperBound(steps, s - W * f);
    const to = upperBound(steps, s);
    const n = to - from;
    if (n < MIN_WINDOW_ROWS) return [];
    const raw = values.slice(from, to);
    const level = mean(raw);
    const noise = Math.sqrt(mean(raw.map(v => (v - level) ** 2)));
    const slopeRel = n > 10 && level ? (slope(steps.slice(from, to), ema.slice(from, to)) * W) / level : 0;
    return [{ c, level, noise, se: noise / Math.sqrt(n), slopeRel }];
  });
  const scores = new Map<string, Scored>();
  if (!stats.length) return { plateau: null, scores };

  // a perfectly constant log has no spread to divide by
  const SE = median(stats.map(t => t.se)) || 1;
  const noiseMed = median(stats.map(t => t.noise)) || 1;
  const levels = stats.map(t => t.level);
  const best = Math.min(...levels);
  const lastStep = stats[stats.length - 1].c.step;
  const onset = stats.find((t, i) => Math.abs(t.slopeRel) < 0.02 && t.level - Math.min(...levels.slice(i)) < 3 * SE);
  const plateau = onset ? onset.c.step : lastStep;

  stats.forEach((t, i) => {
    const reasons: string[] = [];
    const gap = (t.level - best) / SE;
    let score = -gap;
    if (gap < 1.5) reasons.push('loss within noise of the lowest save');
    const near = [levels[i - 1], levels[i + 1]].filter(v => v !== undefined);
    const bump = near.length ? (t.level - mean(near)) / SE : 0;
    if (bump > 2) {
      score -= 1.5 * (bump - 2);
      reasons.push(`loss bump vs neighbours (+${bump.toFixed(1)} SE)`);
    }
    if (t.slopeRel > 0.02) {
      score -= 40 * (t.slopeRel - 0.02);
      reasons.push('loss trending up into this save');
    } else if (t.slopeRel < -0.04) {
      score -= 40 * (-t.slopeRel - 0.04);
      reasons.push('still dropping fast (undertrained?)');
    } else {
      reasons.push('flat trailing slope');
    }
    const ratio = t.noise / noiseMed;
    if (ratio > 1.15) {
      score -= 3 * (ratio - 1.15);
      reasons.push('noisier than usual window');
    }
    if (t.c.step < plateau) {
      score -= 2;
      reasons.push('before plateau');
    } else {
      // past the plateau lower loss mostly means memorising the set, so near-ties go to the earlier save
      score -= (0.6 * (t.c.step - plateau)) / Math.max(1, lastStep - plateau);
    }
    scores.set(t.c.file, { score, reasons });
  });
  return { plateau, scores };
};

export const scoreCheckpoints = (
  checkpoints: CheckpointInput[],
  steps: number[],
  values: number[],
  fractions: number[] = FRACTIONS,
): ScoreResult => {
  const nameCarriesStep = (file: string) => (/_(?:s\d+|\d{6,})\.safetensors$/.test(file) ? 1 : 0);
  const known = checkpoints
    .filter((c): c is Save => c.step !== null)
    .sort((a, b) => a.step - b.step || nameCarriesStep(a.file) - nameCarriesStep(b.file) || a.file.localeCompare(b.file));
  const cks = known.filter((c, i) => i === 0 || c.step !== known[i - 1].step);

  const interval = Math.floor(median(cks.slice(1).map((c, i) => c.step - cks[i].step)));
  const W = Math.min(500, Math.max(100, interval));
  const ema = zeroPhaseEma(values, 2 / (W / 2 + 1));
  const runs = fractions.map(f => scoreWindow(cks, steps, values, ema, W, f));
  const primary = runs[fractions.indexOf(Math.max(...fractions))];

  const finalFile = cks.length ? cks[cks.length - 1].file : null;
  const rows = new Map<string, CandidateRow & { exact: number | null }>();
  for (const c of checkpoints) {
    const kept = cks.includes(c as Save);
    const got = runs.flatMap(r => r.scores.get(c.file)?.score ?? []);
    const exact = kept && got.length ? mean(got) : null;
    const reasons = !kept
      ? [c.step === null ? 'unknown step' : 'same step as another save']
      : exact === null
        ? [NO_ROWS]
        : [...(primary.scores.get(c.file) as Scored).reasons];
    rows.set(c.file, { ...c, score: exact, exact, reasons, recommended: false, isFinal: c.file === finalFile });
  }

  const ranked = cks.map(c => rows.get(c.file)!).filter(r => r.exact !== null);
  ranked.sort((a, b) => (b.exact as number) - (a.exact as number));
  const picks: typeof ranked = [];
  for (const r of ranked) {
    if (picks.length < 3 && picks.every(p => Math.abs((r.step as number) - (p.step as number)) >= interval)) picks.push(r);
  }
  if (primary.plateau !== null) {
    const earlyBy = primary.plateau + interval;
    const isEarly = (r: CandidateRow) => (r.step as number) <= earlyBy;
    const early = ranked.find(r => isEarly(r) && !picks.includes(r));
    if (early && !picks.some(isEarly)) {
      early.reasons.push(EARLY);
      picks.push(early);
    }
  }
  picks.forEach(r => (r.recommended = true));
  if (cks.length < 4) ranked.forEach(r => (r.recommended = true));
  if (finalFile) rows.get(finalFile)!.reasons.push('final save');

  return {
    interval,
    window: W,
    plateauStep: primary.plateau,
    ema,
    checkpoints: checkpoints.map(c => {
      const { exact, ...row } = rows.get(c.file)!;
      return { ...row, score: exact === null ? null : Math.round(exact * 1000) / 1000 };
    }),
  };
};

/** Off-limits on the path as written or where a link really points; a missing file also fails. */
const allowedFile = (p: string) => {
  if (isForbiddenPath(p)) return false;
  try {
    return !isForbiddenPath(fs.realpathSync.native(p));
  } catch {
    return false;
  }
};

/** The step saved in a safetensors header. Reads the header only, never the tensors. */
export const readHeaderStep = (file: string): number | null => {
  if (!allowedFile(file)) return null;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = Buffer.alloc(8);
    if (fs.readSync(fd, size, 0, 8, 0) !== 8) return null;
    const n = Number(size.readBigUInt64LE(0));
    if (n > MAX_HEADER_BYTES || 8 + n > fs.fstatSync(fd).size) return null;
    const header = Buffer.alloc(n);
    if (fs.readSync(fd, header, 0, n, 8) !== n) return null;
    // training_info is a JSON string inside the JSON header
    const step = JSON.parse(JSON.parse(header.toString('utf-8')).__metadata__.training_info).step;
    return Number.isInteger(step) && step >= 0 ? step : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

/** A promoted folder holds no log, so fall back to the run it came from. */
export const findLossDb = (folder: string, trainingRoot: string): string | null =>
  [folder, path.join(trainingRoot, path.basename(folder))].map(d => path.join(d, 'loss_log.db')).find(allowedFile) ?? null;

const all = <T>(db: sqlite3.Database, sql: string, params: unknown[] = []) =>
  new Promise<T[]>((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[]))));

const loadLoss = async (file: string) => {
  let db: sqlite3.Database | undefined;
  try {
    // read-only: the trainer may be writing this log (WAL) right now
    db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const opened = new sqlite3.Database(file, sqlite3.OPEN_READONLY, err => (err ? reject(err) : resolve(opened)));
    });
    db.configure('busyTimeout', 30_000);
    const keys = (await all<{ key: string }>(db, 'SELECT key FROM metric_keys')).map(r => r.key);
    const key = ['loss/loss', 'loss'].find(k => keys.includes(k)) ?? keys.find(k => k.toLowerCase().includes('loss'));
    if (!key) return null;
    // plain rows, not json_group_array: JSON cannot carry an Infinity back reliably
    const rows = await all<{ step: number; value_real: number }>(
      db,
      'SELECT step, value_real FROM metrics WHERE key = ? AND value_real IS NOT NULL ORDER BY step',
      [key],
    );
    const finite = rows.filter(r => Number.isFinite(r.value_real));
    if (!finite.length) return null;
    return { key, steps: finite.map(r => r.step), values: finite.map(r => r.value_real) };
  } catch {
    return null;
  } finally {
    const open = db;
    if (open) await new Promise<void>(resolve => open.close(() => resolve()));
  }
};

export const loadCandidates = async (
  folder: string,
  trainingRoot: string,
  fractions: number[] = FRACTIONS,
): Promise<CandidatesResponse> => {
  const inputs = listCheckpoints(folder).map((c): CheckpointInput => {
    const header = readHeaderStep(c.path);
    return {
      file: c.file,
      step: header ?? c.step,
      stepSource: header !== null ? 'metadata' : c.step !== null ? 'filename' : null,
    };
  });
  const dbFile = findLossDb(folder, trainingRoot);
  const loss = dbFile ? await loadLoss(dbFile) : null;
  const steps = loss?.steps ?? [];
  const result = scoreCheckpoints(inputs, steps, loss?.values ?? [], fractions);
  const every = Math.max(1, Math.ceil(steps.length / SPARKLINE_POINTS));
  const keep = (_: number, i: number) => i % every === 0 || i === steps.length - 1;
  return {
    lossAvailable: !!loss,
    lossKey: loss?.key ?? null,
    interval: result.interval,
    window: result.window,
    plateauStep: result.plateauStep,
    sparkline: { steps: steps.filter(keep), values: result.ema.filter(keep) },
    checkpoints: result.checkpoints,
  };
};
