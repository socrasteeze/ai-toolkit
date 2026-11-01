// Fork-only (see FORK_NOTES.md). Checkpoint Compare's pure helpers: run lookup, cache
// names, trigger + bucket ports, promote paths. No Prisma, so tests load it on bare Node.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// shortcut: the operator's library path from the spec, move to Settings if this runs elsewhere
const LORA_LIBRARY = 'E:\\models\\loras';

// same order as promote.py: 'flux2_klein_9b' must hit klein before flux
const ARCH_DIRS: [string, string][] = [
  ['anima', 'anima'],
  ['krea', 'krea'],
  ['klein', 'klein'],
  ['qwen', 'qwen'],
  ['wan', 'wan'],
  ['ltx', 'ltx2'],
  ['flux', 'flux'],
  ['sdxl', 'sdxl'],
  ['illustrious', 'illustrious'],
];

// supported archs -> each model's get_bucket_divisibility(), which the data loader buckets with
const BUCKET_DIVISIBILITY: Record<string, number> = { anima: 32, krea2: 16, flux2_klein_9b: 16 };

// what the engine's ModelConfig takes from a training config; the rest is training-only
const MODEL_KEYS = [
  'arch',
  'name_or_path',
  'extras_name_or_path',
  'quantize',
  'qtype',
  'quantize_te',
  'qtype_te',
  'low_vram',
  'layer_offloading',
  'layer_offloading_transformer_percent',
  'layer_offloading_text_encoder_percent',
];

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Operator hard rule: archive and IRL folders are never read, listed, copied or written. */
export const isForbiddenPath = (p: string) =>
  p.split(/[\\/]+/).some(seg => /_archive/i.test(seg) || /(^|[^a-z0-9])irl($|[^a-z0-9])/i.test(seg));

const assertAllowed = (p: string) => {
  if (isForbiddenPath(p)) throw new Error('This folder is off limits: archive and IRL folders are never opened.');
};

// path.relative is case-insensitive on Windows, unlike a startsWith prefix check
export const isUnder = (child: string, root: string) => {
  const rel = path.relative(root, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const realpath = (p: string) => fs.realpathSync.native(p);

export const resolveRunFolder = (run: string, trainingRoot: string): string => {
  const candidate = path.resolve(trainingRoot, run);
  const promoted = candidate
    .split(/[\\/]+/)
    .slice(0, -1)
    .some(seg => seg.toLowerCase() === 'trained');
  if (!isUnder(candidate, trainingRoot) && !promoted) {
    throw new Error('Pick a folder under the training folder or under a trained library folder.');
  }
  assertAllowed(candidate);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) throw new Error('Run folder not found.');
  assertAllowed(realpath(candidate));
  return candidate;
};

export const listRunFolders = (trainingRoot: string): string[] =>
  fs
    .readdirSync(trainingRoot, { withFileTypes: true })
    .filter(e => e.isDirectory() && !isForbiddenPath(e.name))
    .map(e => e.name)
    .filter(name => fs.readdirSync(path.join(trainingRoot, name)).some(f => f.endsWith('.safetensors')))
    .sort((a, b) => a.localeCompare(b));

export interface Checkpoint {
  file: string;
  path: string;
  step: number | null;
  label: string;
  mtimeMs: number;
}

export const listCheckpoints = (folder: string): Checkpoint[] =>
  fs
    .readdirSync(folder)
    .filter(f => f.endsWith('.safetensors'))
    .map(file => {
      // trainer names end _000000100; promoted names end _s100
      const m = file.match(/_(?:s(\d+)|(\d{6,}))\.safetensors$/);
      const step = m ? parseInt(m[1] ?? m[2], 10) : null;
      const full = path.join(folder, file);
      return {
        file,
        path: full,
        step,
        label: step === null ? 'final' : `step ${step}`,
        mtimeMs: fs.statSync(full).mtimeMs,
      };
    })
    .sort((a, b) => (a.step ?? Infinity) - (b.step ?? Infinity) || a.file.localeCompare(b.file));

export interface RunInfo {
  folder: string;
  runName: string;
  outputDir: string; // <output folder>\<run>, where renders and scores.json live
  arch: string;
  supported: boolean;
  model: Record<string, unknown>;
  trigger: string | null;
  datasetFolders: string[];
  blockedDatasets: number;
  resolution: number;
  divisibility: number;
  sample: { steps: number; cfg: number; neg: string };
}

export const readRunInfo = (folder: string, trainingRoot: string, outputRoot: string): RunInfo => {
  const runName = path.basename(folder);
  const outputDir = path.join(outputRoot, runName);
  assertAllowed(outputDir);
  // a promoted folder holds no config: fall back to the run it came from
  const configPath = [folder, path.join(trainingRoot, runName)]
    .map(dir => path.join(dir, '.job_config.json'))
    .find(p => fs.existsSync(p));
  if (!configPath) throw new Error('No .job_config.json for this run, so its model is unknown.');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const proc = (raw.config ?? raw).process[0];
  const ds = proc.datasets?.[0] ?? {};
  const model: Record<string, unknown> = {};
  for (const key of MODEL_KEYS) if (proc.model?.[key] !== undefined) model[key] = proc.model[key];
  const arch = String(model.arch ?? '');
  const folders: string[] = ([] as string[]).concat(ds.folder_path ?? ds.dataset_path ?? []);
  const datasetFolders = folders.filter(f => !isForbiddenPath(f) && fs.existsSync(f) && !isForbiddenPath(realpath(f)));
  const resolution = Math.max(...([] as number[]).concat(ds.resolution ?? 1024));
  return {
    folder,
    runName,
    outputDir,
    arch,
    supported: arch in BUCKET_DIVISIBILITY,
    model,
    trigger: ds.trigger_word ?? proc.trigger_word ?? null,
    datasetFolders,
    blockedDatasets: folders.length - datasetFolders.length,
    resolution,
    divisibility: BUCKET_DIVISIBILITY[arch] ?? 32,
    sample: {
      steps: proc.sample?.sample_steps ?? 25,
      cfg: proc.sample?.guidance_scale ?? 4,
      neg: proc.sample?.neg ?? '',
    },
  };
};

/** Every image in the run's dataset, relative to its folder, with hidden and control trees pruned. */
export const listReferences = (info: RunInfo): string[] => {
  const out: string[] = [];
  const walk = (root: string, rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? path.join(rel, e.name) : e.name;
      if (e.name.startsWith('.') || e.name === '_controls' || isForbiddenPath(e.name)) continue;
      if (e.isDirectory()) walk(root, child);
      else if (IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) out.push(child);
    }
  };
  info.datasetFolders.forEach(root => walk(root, ''));
  return out.sort((a, b) => a.localeCompare(b));
};

export const resolveReference = (info: RunInfo, rel: string): string => {
  for (const root of info.datasetFolders) {
    const full = path.resolve(root, rel);
    if (isUnder(full, root) && IMAGE_EXTS.has(path.extname(full).toLowerCase()) && fs.existsSync(full)) {
      assertAllowed(full);
      if (!isUnder(realpath(full), realpath(root))) break;
      return full;
    }
  }
  throw new Error("Reference image not found in this run's dataset.");
};

export const readCaption = (imagePath: string): string => {
  const txt = imagePath.slice(0, -path.extname(imagePath).length) + '.txt';
  return fs.existsSync(txt) ? fs.readFileSync(txt, 'utf-8').trim() : '';
};

/** toolkit/prompt_utils.py inject_trigger_into_prompt: plain replace, prepend if missing, no escaping. */
export const injectTrigger = (prompt: string, trigger: string | null): string => {
  const t = trigger ?? '';
  const out = prompt.split('[name]').join(t).split('[trigger]').join(t);
  return t.trim() !== '' && !out.includes(t) ? `${t} ${out}` : out;
};

/** toolkit/buckets.py get_bucket_for_image_size. */
export const bucketFor = (width: number, height: number, resolution: number, divisibility: number) => {
  const total = width * height;
  const maxPixels = resolution * resolution;
  const target = Math.min(total, maxPixels);
  const scaler = Math.sqrt(target / total);
  const wRaw = (width * scaler) / divisibility;
  const hRaw = (height * scaler) / divisibility;
  const candidates: [number, number][] = [
    [Math.floor(wRaw) * divisibility, Math.floor(hRaw) * divisibility],
    [Math.floor(wRaw) * divisibility, Math.ceil(hRaw) * divisibility],
    [Math.ceil(wRaw) * divisibility, Math.floor(hRaw) * divisibility],
    [Math.ceil(wRaw) * divisibility, Math.ceil(hRaw) * divisibility],
  ];
  const capped = candidates.filter(([w, h]) => w > 0 && h > 0 && w * h <= maxPixels);
  const pool: [number, number][] = capped.length
    ? capped
    : [[Math.max(divisibility, Math.floor(wRaw) * divisibility), Math.max(divisibility, Math.floor(hRaw) * divisibility)]];
  let best = pool[0];
  for (const c of pool) if (Math.abs(c[0] * c[1] - target) < Math.abs(best[0] * best[1] - target)) best = c;
  return { width: best[0], height: best[1] };
};

export interface RenderParams {
  prompt: string;
  neg: string;
  seed: number;
  width: number;
  height: number;
  steps: number;
  cfg: number;
}

export interface PlanItem {
  key: string; // cache file name, generic on purpose (no run or dataset names)
  kind: 'main' | 'bleed';
  label: string;
  file: string | null;
  step: number | null;
  loraPath: string | null;
  params: RenderParams;
}

type CacheIdentity = Pick<Checkpoint, 'file' | 'mtimeMs' | 'step'> | null;

const slugOf = (c: CacheIdentity) =>
  !c ? 'baseline' : c.step === null ? 'final' : `s${String(c.step).padStart(9, '0')}`;

export const renderKey = (c: CacheIdentity, p: RenderParams) => {
  const id = [c?.file ?? null, c?.mtimeMs ?? null, p.prompt, p.neg, p.seed, p.width, p.height, p.steps, p.cfg];
  return `${slugOf(c)}_${crypto.createHash('sha1').update(JSON.stringify(id)).digest('hex').slice(0, 12)}.png`;
};

export interface PlanRequest extends RenderParams {
  bleed?: string;
  baseline?: boolean;
}

const intIn = (v: unknown, min: number, max: number, name: string) => {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) {
    throw new Error(`${name} must be ${min} to ${max}.`);
  }
  return v as number;
};

export const buildPlan = (info: RunInfo, req: PlanRequest): PlanItem[] => {
  if (typeof req.prompt !== 'string' || !req.prompt.trim()) throw new Error('Prompt is empty.');
  if (typeof req.cfg !== 'number' || !Number.isFinite(req.cfg) || req.cfg < 0 || req.cfg > 30) {
    throw new Error('CFG must be 0 to 30.');
  }
  const base = {
    neg: typeof req.neg === 'string' ? req.neg : '',
    // a random seed would make the cache lie
    seed: intIn(req.seed, 0, 4294967295, 'Seed'),
    width: intIn(req.width, 64, 4096, 'Width'),
    height: intIn(req.height, 64, 4096, 'Height'),
    steps: intIn(req.steps, 1, 200, 'Steps'),
    cfg: req.cfg,
  };
  const prompts: [PlanItem['kind'], string][] = [['main', injectTrigger(req.prompt, info.trigger)]];
  if (req.bleed?.trim()) prompts.push(['bleed', injectTrigger(req.bleed, null)]);
  const checkpoints: (Checkpoint | null)[] = listCheckpoints(info.folder);
  if (req.baseline) checkpoints.unshift(null);
  return checkpoints.flatMap(c =>
    prompts.map(([kind, prompt]) => {
      const params = { ...base, prompt };
      return {
        key: renderKey(c, params),
        kind,
        label: c ? c.label : 'no LoRA',
        file: c?.file ?? null,
        step: c?.step ?? null,
        loraPath: c?.path ?? null,
        params,
      };
    }),
  );
};

/** The output folder is the operator's choice, so it must be a real absolute path off the forbidden list. */
export const validateOutputFolder = (folder: unknown): string => {
  if (typeof folder !== 'string' || !path.isAbsolute(folder.trim())) throw new Error('Enter a full folder path.');
  const resolved = path.resolve(folder.trim());
  assertAllowed(resolved);
  return resolved;
};

/** A public image URL's file: only <run>\<generated render name> under the output folder, never any other png there. */
export const resolveRenderFile = (outputRoot: string, file: string): string | null => {
  const parts = file.split(/[\\/]+/);
  if (parts.length !== 2 || !/^(baseline|final|s\d{9})_[0-9a-f]{12}\.png$/.test(parts[1])) return null;
  const full = path.resolve(outputRoot, parts[0], parts[1]);
  return isUnder(full, outputRoot) && !isForbiddenPath(full) ? full : null;
};

/** promote.py: <real library folder for the arch>\trained\<run>\<name>.safetensors */
export const promoteDest = (arch: string, runName: string, name: string, resolve = realpath): string => {
  const lower = arch.toLowerCase();
  const sub = ARCH_DIRS.find(([key]) => lower.includes(key))?.[1];
  if (!sub) throw new Error(`No library folder is mapped for arch ${arch}.`);
  const library = path.win32.join(LORA_LIBRARY, sub);
  let real = library;
  try {
    real = resolve(library);
  } catch {
    // promote.py's realpath also keeps a path that does not exist yet
  }
  const dest = path.win32.join(real, 'trained', runName, `${name}.safetensors`);
  assertAllowed(dest);
  return dest;
};

export const promotedName = (runName: string, c: Pick<Checkpoint, 'step'>) =>
  c.step === null ? runName : `${runName}_s${c.step}`;

/** Copy only, never a move. Refuses an existing destination unless overwrite is set. */
export const promoteCheckpoint = async (src: string, dest: string, overwrite: boolean): Promise<'exists' | 'copied'> => {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.copyFile(src, dest, overwrite ? 0 : fs.constants.COPYFILE_EXCL);
  } catch (e: any) {
    if (e?.code === 'EEXIST') return 'exists';
    throw e;
  }
  const st = await fs.promises.stat(src);
  await fs.promises.utimes(dest, st.atime, st.mtime); // shutil.copy2 keeps the mtime
  return 'copied';
};
