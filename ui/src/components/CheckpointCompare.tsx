'use client';

// Fork-only (see FORK_NOTES.md). Used by the job page's Compare tab (job set) and by
// /generate/compare (any run folder). Renders run on the server, so this only polls state.
import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Job } from '@prisma/client';
import { Checkbox, NumberInput, TextAreaInput, TextInput } from '@/components/formInputs';
import { openConfirm } from '@/components/ConfirmModal';
import usePollLoop from '@/hooks/usePollLoop';
import { apiClient } from '@/utils/api';

interface RunData {
  runName: string;
  arch: string;
  supported: boolean;
  hasTrigger: boolean;
  blockedDatasets: number;
  outputDir: string;
  promoteFolder: string | null;
  sample: { steps: number; cfg: number; neg: string };
  checkpoints: { file: string; label: string }[];
  references: string[];
}

interface Row {
  key: string;
  kind: 'main' | 'bleed';
  label: string;
  file: string | null;
  cached: boolean;
  score: number | null;
  method: string | null;
}

interface StateData {
  rows: Row[];
  engineReady: boolean;
  job: { status: string; total: number; done: number; message: string; error: string | null } | null;
}

interface Candidates {
  lossAvailable: boolean;
  interval: number;
  plateauStep: number | null;
  sparkline: { steps: number[]; values: number[] };
  checkpoints: {
    file: string;
    step: number | null;
    score: number | null;
    reasons: string[];
    recommended: boolean;
    isFinal: boolean;
  }[];
}

const NO_LOSS: Candidates = {
  lossAvailable: false,
  interval: 0,
  plateauStep: null,
  sparkline: { steps: [], values: [] },
  checkpoints: [],
};

function LossSparkline({ candidates, chosen }: { candidates: Candidates; chosen: Set<string> }) {
  const { steps, values } = candidates.sparkline;
  if (steps.length < 2) return null;
  const [w, h] = [600, 72];
  const [low, high] = [Math.min(...values), Math.max(...values)];
  const x = (step: number) => Math.min(w, ((step - steps[0]) / (steps[steps.length - 1] - steps[0])) * w);
  const y = (v: number) => h - 4 - ((v - low) / (high - low || 1)) * (h - 8);
  const saves = candidates.checkpoints.filter(c => c.step !== null);
  const plateau = candidates.plateauStep;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="w-full h-16 rounded bg-gray-900"
      role="img"
      aria-label={`Smoothed loss with ${saves.length} saves${plateau === null ? '' : `, flat from step ${plateau}`}.`}
    >
      {plateau !== null && <rect x={x(plateau)} y={0} width={w - x(plateau)} height={h} className="fill-emerald-900/30" />}
      {saves.map(c => (
        <line
          key={c.file}
          x1={x(c.step as number)}
          x2={x(c.step as number)}
          y1={0}
          y2={h}
          vectorEffect="non-scaling-stroke"
          className={chosen.has(c.file) ? 'stroke-blue-400' : c.recommended ? 'stroke-emerald-500' : 'stroke-gray-700'}
        />
      ))}
      <polyline
        points={steps.map((s, i) => `${x(s)},${y(values[i])}`).join(' ')}
        fill="none"
        vectorEffect="non-scaling-stroke"
        className="stroke-gray-200"
      />
    </svg>
  );
}

const errorOf = (e: any) => e?.response?.data?.error || e?.message || String(e);
const fmt = (score: number | null | undefined) => (score == null ? '-' : score.toFixed(3));
const RunSelect = dynamic(() => import('react-select/creatable'), { ssr: false });
const LAST_RUN_KEY = 'checkpointCompare.lastRun';
const settingsKey = (run: string) => `checkpointCompare.settings.${run}`;
const readSaved = (run: string) => {
  try {
    return JSON.parse(localStorage.getItem(settingsKey(run)) ?? 'null');
  } catch {
    return null;
  }
};

export default function CheckpointCompare({ job }: { job?: Job }) {
  const [runs, setRuns] = useState<string[]>([]);
  const [outputFolder, setOutputFolder] = useState('');
  const [run, setRun] = useState(job?.name ?? '');
  // settings save only once this run's own values are in state, never the previous run's
  const [loadedRun, setLoadedRun] = useState('');
  const [data, setData] = useState<RunData | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [bleed, setBleed] = useState('');
  const [neg, setNeg] = useState('');
  const [seed, setSeed] = useState(42);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [steps, setSteps] = useState(25);
  const [cfg, setCfg] = useState(4);
  const [baseline, setBaseline] = useState(false);
  const [state, setState] = useState<StateData | null>(null);
  const [selected, setSelected] = useState(0);
  const [wipe, setWipe] = useState(50);
  const [grid, setGrid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  // null until this run's selection is known; `selected` above is the slider index
  const [chosenFiles, setChosenFiles] = useState<string[] | null>(null);

  useEffect(() => {
    apiClient
      .get('/api/compare')
      .then(r => {
        setRuns(r.data.runs);
        setOutputFolder(r.data.outputFolder);
      })
      .catch(e => setError(errorOf(e)));
  }, []);

  const saveOutputFolder = () =>
    apiClient
      .post('/api/compare', { action: 'output', folder: outputFolder })
      .then(r => {
        setOutputFolder(r.data.outputFolder);
        setNotice(`Renders now go to ${r.data.outputFolder}`);
        setError(null);
        // the run's own output path changes with it
        return run ? apiClient.get('/api/compare', { params: { run } }).then(d => setData(d.data)) : undefined;
      })
      .catch(e => setError(errorOf(e)));

  // read after mount: the server render has no localStorage
  useEffect(() => {
    if (!job) setRun(localStorage.getItem(LAST_RUN_KEY) ?? '');
  }, [job]);

  useEffect(() => {
    if (!job && run) localStorage.setItem(LAST_RUN_KEY, run);
  }, [job, run]);

  useEffect(() => {
    setData(null);
    setState(null);
    setReference(null);
    setLoadedRun('');
    setCandidates(null);
    setChosenFiles(null);
    if (!run) return;
    setError(null);
    let stale = false;
    apiClient
      .get('/api/compare', { params: { run } })
      .then(r => {
        if (stale) return;
        const d: RunData = r.data;
        const saved = readSaved(run);
        const restore = !!saved && d.references.includes(saved.reference);
        setData(d);
        setSteps(restore ? saved.steps : d.sample.steps);
        setCfg(restore ? saved.cfg : d.sample.cfg);
        setNeg(restore ? saved.neg : d.sample.neg);
        if (restore) {
          setReference(saved.reference);
          setPrompt(saved.prompt);
          setBleed(saved.bleed);
          setSeed(saved.seed);
          setWidth(saved.width);
          setHeight(saved.height);
          setBaseline(saved.baseline);
        }
        setLoadedRun(run);
      })
      .catch(e => {
        if (!stale) setError(errorOf(e));
      });
    return () => {
      stale = true;
    };
  }, [run]);

  // the poll re-lists the run, so a save written during training shows up here without a reload
  const polled = (state?.rows ?? []).flatMap(r => (r.kind === 'main' && r.file ? [{ file: r.file, label: r.label }] : []));
  const inventory = state ? polled : (data?.checkpoints ?? []);
  const inventoryKey = inventory.map(c => c.file).join('|');
  const recommendedFiles = inventory
    .filter(c => candidates?.checkpoints.some(k => k.file === c.file && k.recommended))
    .map(c => c.file);

  // shortcut: refreshes only when the save list changes, so a log edited with this page open shows after a reload; poll if that starts to matter
  useEffect(() => {
    if (!run || loadedRun !== run) return;
    let stale = false;
    apiClient
      .get('/api/compare/candidates', { params: { run } })
      .then(r => {
        if (!stale) setCandidates(r.data);
      })
      .catch(() => {
        if (!stale) setCandidates(NO_LOSS);
      });
    return () => {
      stale = true;
    };
  }, [run, loadedRun, inventoryKey]);

  useEffect(() => {
    if (!data || !candidates || chosenFiles !== null || loadedRun !== run) return;
    const names = inventory.map(c => c.file);
    const saved = readSaved(run)?.files;
    if (Array.isArray(saved) && !saved.length) return setChosenFiles([]); // Clear and baseline-only save this on purpose
    const kept = Array.isArray(saved) ? names.filter(f => saved.includes(f)) : [];
    setChosenFiles(kept.length ? kept : recommendedFiles.length ? recommendedFiles : names);
  }, [data, candidates, chosenFiles, loadedRun, run, inventoryKey]);

  const pickReference = async (rel: string) => {
    setError(null);
    try {
      const { data: d } = await apiClient.get('/api/compare', { params: { run, reference: rel } });
      setReference(rel);
      setPrompt(d.caption);
      setWidth(d.bucket.width);
      setHeight(d.bucket.height);
    } catch (e) {
      setError(errorOf(e));
    }
  };

  const request = useMemo(
    () => ({ run, reference, prompt, bleed, neg, seed, width, height, steps, cfg, baseline }),
    [run, reference, prompt, bleed, neg, seed, width, height, steps, cfg, baseline],
  );

  useEffect(() => {
    if (request.reference && loadedRun === request.run && chosenFiles !== null) {
      localStorage.setItem(settingsKey(request.run), JSON.stringify({ ...request, files: chosenFiles }));
    }
  }, [request, loadedRun, chosenFiles]);

  // a slow reply from a previous run or prompt must not land on this one
  const latestRequest = useRef(request);
  latestRequest.current = request;

  // no `files` here: every row and the job status come back whatever is selected, and `rows` filters below
  usePollLoop(
    () =>
      reference && prompt.trim()
        ? apiClient
            .post('/api/compare', { action: 'state', ...request })
            .then(r => {
              if (latestRequest.current !== request) return;
              setState(r.data);
              setError(null);
            })
            .catch(e => {
              if (latestRequest.current === request) setError(errorOf(e));
            })
        : Promise.resolve(),
    2000,
    [request],
  );

  const render = () =>
    apiClient
      .post('/api/compare', { action: 'render', ...request, files: chosenFiles })
      .then(r => setState(s => (s ? { ...s, job: r.data.job } : s)))
      .catch(e => setError(errorOf(e)));

  const cancel = () => apiClient.post('/api/compare', { action: 'cancel', run }).catch(e => setError(errorOf(e)));

  const promote = (file: string, overwrite = false) =>
    apiClient
      .post('/api/compare', { action: 'promote', run, file, overwrite })
      .then(r => setNotice(`Promoted to ${r.data.dest}`))
      .catch(e => {
        if (e?.response?.status !== 409) return setError(errorOf(e));
        openConfirm({
          title: 'Overwrite Promoted LoRA',
          message: `${e.response.data.dest} already exists. Replace it with this checkpoint?`,
          type: 'warning',
          confirmText: 'Overwrite',
          onConfirm: () => {
            promote(file, true);
          },
        });
      });

  const chosen = new Set(chosenFiles ?? []);
  const rows = chosenFiles ? (state?.rows ?? []).filter(r => r.file === null || chosen.has(r.file)) : [];
  const toggleFile = (file: string, on: boolean) =>
    setChosenFiles(list => (on ? [...(list ?? []), file] : (list ?? []).filter(f => f !== file)));
  const mains = rows.filter(r => r.kind === 'main');
  const bleedOf = (m: Row) => rows.find(r => r.kind === 'bleed' && r.label === m.label && r.file === m.file);
  const rendered = mains.filter(r => r.cached);
  const shown = rendered[Math.min(selected, Math.max(rendered.length - 1, 0))];
  const best = mains
    .filter(r => r.file && r.score != null)
    .reduce<Row | null>((a, r) => (a && (a.score as number) >= (r.score as number) ? a : r), null);
  const method = rows.find(r => r.method)?.method;
  const running = state?.job?.status === 'running';
  const missing = rows.filter(r => !r.cached).length;
  const hasBleed = !!bleed.trim();
  const renderUrl = (key: string) => `/api/compare/img?file=${encodeURIComponent(`${data?.runName}/${key}`)}`;
  // the server's .thumbs are center-cropped squares, which would cut the 3:4 tiles short
  const refUrl = (rel: string) => `/api/compare/img?run=${encodeURIComponent(run)}&reference=${encodeURIComponent(rel)}`;

  return (
    <div className="space-y-4 text-sm text-gray-200">
      {!job && (
        <div>
          <span id="compare-run-label" className="block text-xs text-gray-400 mb-1">
            Run Name or Promoted Folder
          </span>
          <RunSelect
            aria-labelledby="compare-run-label"
            className="aitk-react-select-container"
            classNamePrefix="aitk-react-select"
            menuPosition="fixed"
            menuPlacement="auto"
            placeholder="Pick a run, or type a promoted folder path"
            value={run ? { value: run, label: run } : null}
            options={runs.map(r => ({ value: r, label: r }))}
            formatCreateLabel={(path: string) => `Load ${path}`}
            onChange={selected => {
              if (selected) setRun((selected as { value: string }).value.trim());
            }}
          />
        </div>
      )}

      <form
        className="flex items-end gap-2"
        onSubmit={e => {
          e.preventDefault();
          saveOutputFolder();
        }}
      >
        <label className="flex-1">
          <span className="block text-xs text-gray-400 mb-1">Output Folder (Each Run Gets a Subfolder)</span>
          <input
            value={outputFolder}
            onChange={e => setOutputFolder(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5"
          />
        </label>
        <button type="submit" className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600">
          Save Folder
        </button>
      </form>

      {error && <div className="rounded bg-rose-950/70 text-rose-200 px-3 py-2 whitespace-pre-wrap">{error}</div>}
      {notice && <div className="rounded bg-emerald-950/70 text-emerald-200 px-3 py-2 break-all">{notice}</div>}
      {run && !data && !error && <p className="text-gray-400">Loading run…</p>}

      {data && !data.supported && (
        <p className="rounded bg-amber-950/60 text-amber-200 px-3 py-2">
          Checkpoint Compare is not supported for {data.arch || 'this arch'} yet. It works with Anima, Krea 2 and Klein
          9B.
        </p>
      )}

      {data?.supported && (
        <>
          {data.blockedDatasets > 0 && (
            <p className="text-amber-300">
              {data.blockedDatasets} dataset folder(s) skipped because they are missing, or are archive or IRL folders.
            </p>
          )}
          {!data.references.length && <p className="text-amber-300">This run has no reachable dataset images.</p>}
          <section>
            <h2 className="text-xs text-gray-400 mb-1">Reference Image</h2>
            {/* 9rem columns at 3:4 are 12rem tall, so this height shows exactly 2 rows */}
            <div className="grid grid-cols-[repeat(auto-fill,9rem)] gap-2 overflow-y-auto max-h-[24.5rem]">
              {data.references.map(rel => (
                <button
                  key={rel}
                  type="button"
                  title={rel}
                  aria-label={`Use ${rel} as the reference`}
                  aria-pressed={rel === reference}
                  onClick={() => pickReference(rel)}
                  className={`aspect-[3/4] rounded overflow-hidden border-2 ${rel === reference ? 'border-blue-500' : 'border-transparent hover:border-gray-600'}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={refUrl(rel)} alt="" loading="lazy" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          </section>

          {reference && (
            <>
              <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <TextAreaInput
                    label={data.hasTrigger ? 'Prompt (Trigger Added as in Training)' : 'Prompt'}
                    value={prompt}
                    onChange={setPrompt}
                    rows={4}
                  />
                  <TextInput
                    label="Bleed Prompt (Optional, No Trigger)"
                    value={bleed}
                    onChange={setBleed}
                    placeholder="statue, bronze statue, bronze, metal, monochrome"
                  />
                  <TextInput label="Negative Prompt" value={neg} onChange={setNeg} />
                </div>
                <div className="grid grid-cols-3 gap-2 content-start">
                  <NumberInput label="Seed" value={seed} onChange={v => setSeed(v ?? 0)} min={0} />
                  <NumberInput label="Width" value={width} onChange={v => setWidth(v ?? 0)} min={64} max={4096} />
                  <NumberInput label="Height" value={height} onChange={v => setHeight(v ?? 0)} min={64} max={4096} />
                  <NumberInput label="Steps" value={steps} onChange={v => setSteps(v ?? 0)} min={1} max={200} />
                  <NumberInput label="CFG" value={cfg} onChange={v => setCfg(v ?? 0)} min={0} max={30} />
                  <div className="self-end pb-1">
                    <Checkbox label="No-LoRA Baseline" checked={baseline} onChange={setBaseline} />
                  </div>
                </div>
              </section>

              {chosenFiles && (
                <section className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xs text-gray-400 mr-2">Checkpoints to Render</h2>
                    <button
                      type="button"
                      disabled={!recommendedFiles.length}
                      onClick={() => setChosenFiles(recommendedFiles)}
                      className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-xs"
                    >
                      Select Recommended
                    </button>
                    <button
                      type="button"
                      onClick={() => setChosenFiles(inventory.map(c => c.file))}
                      className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-xs"
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={() => setChosenFiles([])}
                      className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-xs"
                    >
                      Clear
                    </button>
                  </div>
                  {candidates?.lossAvailable ? (
                    <LossSparkline candidates={candidates} chosen={chosen} />
                  ) : (
                    <p className="text-xs text-gray-400">No loss log, select manually.</p>
                  )}
                  <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
                    {inventory.map(c => {
                      const info = candidates?.lossAvailable ? candidates.checkpoints.find(k => k.file === c.file) : undefined;
                      const why = info?.reasons.join('; ') ?? '';
                      return (
                        <li key={c.file} className="flex items-center gap-2">
                          <Checkbox label={c.label} checked={chosen.has(c.file)} onChange={on => toggleFile(c.file, on)} />
                          {info?.recommended && (
                            <span title={why} className="px-1.5 rounded bg-emerald-900 text-emerald-200 text-xs">
                              Recommended<span className="sr-only">: {why}</span>
                            </span>
                          )}
                          {info?.isFinal && <span className="px-1.5 rounded bg-gray-800 text-gray-300 text-xs">Final</span>}
                          {info?.reasons.some(r => r.startsWith('early pick')) && (
                            <span className="px-1.5 rounded bg-gray-800 text-gray-300 text-xs">Early</span>
                          )}
                          {info?.score != null && (
                            <span title={why} className="text-xs text-gray-400">
                              {info.score.toFixed(2)}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              <section className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={render}
                  disabled={running || !state?.engineReady || chosenFiles === null || (!baseline && !inventory.some(c => chosen.has(c.file)))}
                  className="px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white"
                >
                  {missing ? `Render ${missing} Missing` : 'Score Renders'}
                </button>
                {running && (
                  <>
                    <button type="button" onClick={cancel} className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600">
                      Cancel
                    </button>
                    <span className="flex items-center gap-2 text-gray-300">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {state?.job?.done}/{state?.job?.total} · {state?.job?.message}
                    </span>
                  </>
                )}
                {state && !state.engineReady && (
                  <span className="text-amber-300">
                    The engine is off. Start it on the{' '}
                    <Link href="/generate" className="underline">
                      Generate page
                    </Link>
                    .
                  </span>
                )}
                {state?.job?.error && <span className="text-rose-300">{state.job.error}</span>}
              </section>

              {shown && (
                <section className="space-y-2">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      aria-pressed={!grid}
                      onClick={() => setGrid(false)}
                      className={`px-2 py-1 rounded ${!grid ? 'bg-gray-700' : 'bg-gray-900'}`}
                    >
                      Slider
                    </button>
                    <button
                      type="button"
                      aria-pressed={grid}
                      onClick={() => setGrid(true)}
                      className={`px-2 py-1 rounded ${grid ? 'bg-gray-700' : 'bg-gray-900'}`}
                    >
                      Grid
                    </button>
                  </div>
                  {grid ? (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      {rendered.map((r, i) => (
                        <button
                          key={r.key}
                          type="button"
                          onClick={() => {
                            setSelected(i);
                            setGrid(false);
                          }}
                          className="text-left"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={renderUrl(r.key)}
                            alt={r.label}
                            loading="lazy"
                            className={`w-full rounded ${r.key === best?.key ? 'ring-2 ring-emerald-500' : ''}`}
                          />
                          <span className="text-xs text-gray-400">
                            {r.label} · {fmt(r.score)}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <>
                      <label className="block">
                        <span className="text-xs text-gray-400">Checkpoint: {shown.label}</span>
                        <input
                          type="range"
                          min={0}
                          max={rendered.length - 1}
                          value={Math.min(selected, rendered.length - 1)}
                          onChange={e => setSelected(Number(e.target.value))}
                          className="w-full"
                        />
                      </label>
                      <div
                        className="relative mx-auto rounded overflow-hidden bg-black"
                        // portrait buckets must still fit the screen beside their sliders
                        style={{
                          aspectRatio: `${width} / ${height}`,
                          width: `min(100%, 42rem, calc(80vh * ${width / height}))`,
                        }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={refUrl(reference)}
                          alt="Training image"
                          className="absolute inset-0 w-full h-full object-cover"
                        />
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={renderUrl(shown.key)}
                          alt={`Render at ${shown.label}`}
                          className="absolute inset-0 w-full h-full object-cover"
                          style={{ clipPath: `inset(0 0 0 ${wipe}%)` }}
                        />
                        <div className="absolute inset-y-0 w-px bg-white/80" style={{ left: `${wipe}%` }} />
                      </div>
                      <label className="block mx-auto max-w-2xl">
                        <span className="text-xs text-gray-400">Wipe: Training Image (Left) to Render (Right)</span>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={wipe}
                          onChange={e => setWipe(Number(e.target.value))}
                          className="w-full"
                        />
                      </label>
                    </>
                  )}
                </section>
              )}

              {rows.length > 0 && (
                <section>
                  <table className="w-full text-left">
                    <thead className="text-xs text-gray-400">
                      <tr>
                        <th className="py-1 font-normal">Checkpoint</th>
                        <th className="py-1 font-normal">Likeness</th>
                        {hasBleed && <th className="py-1 font-normal">Bleed</th>}
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {mains.map(m => (
                        <tr
                          key={m.key}
                          className={`border-t border-gray-800 ${m.key === best?.key ? 'bg-emerald-950/40' : ''}`}
                        >
                          <td className="py-1">
                            {m.label}
                            {m.key === best?.key && <span className="ml-2 text-xs text-emerald-300">Best</span>}
                            {!m.cached && <span className="ml-2 text-xs text-gray-500">Not rendered</span>}
                          </td>
                          <td className="py-1">{fmt(m.score)}</td>
                          {hasBleed && <td className="py-1">{fmt(bleedOf(m)?.score)}</td>}
                          <td className="py-1 text-right">
                            {m.file && (
                              <button
                                type="button"
                                onClick={() => promote(m.file as string)}
                                className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-xs"
                              >
                                Promote
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data.promoteFolder && (
                    <p className="mt-2 text-xs text-gray-400 break-all">Promote copies to {data.promoteFolder}.</p>
                  )}
                  {method && <p className="text-xs text-gray-400">Method: {method}.</p>}
                  {hasBleed && (
                    <p className="text-xs text-gray-400">
                      High bleed similarity means the identity shows up in prompts without the trigger.
                    </p>
                  )}
                </section>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
