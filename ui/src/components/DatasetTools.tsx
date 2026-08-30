'use client';

// Fork-only component (see FORK_NOTES.md). "Dataset Tools" TopBar button + modal
// on the dataset page: runs the fork's QoL CLIs (scripts/preflight.py,
// scripts/auto_caption.py WD14 tagger, scripts/smart_prep.py U2Net crop) via
// /api/datasets/tools and streams their log. Pre-flight is advisory only — it
// never blocks job submission (deliberate; see PLAN.md Workstream B5 note).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { Modal } from '@/components/Modal';
import { TextInput, NumberInput, Checkbox } from '@/components/formInputs';
import { apiClient } from '@/utils/api';
import usePollLoop from '@/hooks/usePollLoop';

type ToolName = 'preflight' | 'caption' | 'prep';

interface ToolRun {
  runId: string;
  tool: ToolName;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  exitCode: number | null;
  log: string;
  // prep only: the (sanitized) dataset the output is being written to
  outputName?: string;
}

const STATUS_LABEL: Record<ToolRun['status'], string> = {
  running: 'running…',
  done: 'finished',
  failed: 'failed',
  cancelled: 'cancelled',
};
const STATUS_CLASS: Record<ToolRun['status'], string> = {
  running: 'text-yellow-400',
  done: 'text-green-400',
  failed: 'text-red-400',
  cancelled: 'text-gray-400',
};

type Props = {
  datasetName: string;
  onDatasetChanged?: () => void;
};

const TOOL_LABELS: Record<ToolName, string> = {
  preflight: 'Pre-flight Check',
  caption: 'WD14 Auto-Tag',
  prep: 'Smart Resize/Crop',
};
const POLL_TIMEOUT_MS = 10_000;

export default function DatasetTools({ datasetName, onDatasetChanged }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [run, setRun] = useState<ToolRun | null>(null);
  const [pollRunId, setPollRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // WD14 options
  const [generalThresh, setGeneralThresh] = useState(0.35);
  const [charThresh, setCharThresh] = useState(0.85);
  const [triggerWord, setTriggerWord] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  // prep options
  const [buckets, setBuckets] = useState('512x768');
  const [outName, setOutName] = useState('');
  // let smart_prep resume into an output dataset that already exists (the route
  // refuses otherwise, so a typo naming another dataset can't merge into it)
  const [resume, setResume] = useState(false);

  const logRef = useRef<HTMLPreElement | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollRun = useCallback(async () => {
    if (!isOpen || !pollRunId) return;

    const controller = new AbortController();
    pollAbortRef.current?.abort();
    pollAbortRef.current = controller;
    try {
      const res = await apiClient.get(`/api/datasets/tools?runId=${encodeURIComponent(pollRunId)}`, {
        signal: controller.signal,
        timeout: POLL_TIMEOUT_MS,
      });
      const nextRun: ToolRun | null = res.data.run;
      if (!nextRun) {
        setPollRunId(null);
        return;
      }

      // keep the output name the POST reported — the poll payload doesn't carry it
      setRun(prev => ({ ...nextRun, outputName: prev?.runId === nextRun.runId ? prev.outputName : undefined }));
      // A poll that got through clears whatever the last failed one reported, so
      // a blip that recovers on its own does not leave a stale error on screen.
      setError(null);
      if (nextRun.status !== 'running') {
        setPollRunId(null);
        if (nextRun.tool !== 'preflight') onDatasetChanged?.();
      }
    } catch (err: any) {
      // usePollLoop swallows a rejection and keeps polling, which is what we want
      // for a transient failure — but it shows the user nothing, so the panel
      // would sit on "running" forever with no explanation. Report and keep going.
      if (err?.code !== 'ERR_CANCELED') {
        setError(err?.response?.data?.error ?? 'Lost contact with the tool run — still retrying');
      }
    } finally {
      if (pollAbortRef.current === controller) pollAbortRef.current = null;
    }
  }, [isOpen, pollRunId, onDatasetChanged]);

  // usePollLoop schedules only after the request settles, so a slow response
  // cannot overlap the next poll. Rejections are caught by the hook and retried.
  usePollLoop(pollRun, isOpen && pollRunId ? 1000 : null, [isOpen, pollRunId]);

  useEffect(() => {
    return () => {
      pollAbortRef.current?.abort();
      pollAbortRef.current = null;
    };
  }, [isOpen, pollRunId]);

  // resume watching an in-flight run if the modal is reopened
  useEffect(() => {
    if (!isOpen) {
      setPollRunId(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    apiClient
      .get(`/api/datasets/tools?datasetName=${encodeURIComponent(datasetName)}`, {
        signal: controller.signal,
        timeout: POLL_TIMEOUT_MS,
      })
      .then(res => {
        if (cancelled) return;
        const activeRun: ToolRun | null = res.data.run;
        if (activeRun) {
          setRun(activeRun);
          if (activeRun.status === 'running') setPollRunId(activeRun.runId);
        }
      })
      .catch(err => {
        if (!cancelled && err?.code !== 'ERR_CANCELED') {
          setError(err?.response?.data?.error ?? 'Failed to check dataset tools');
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isOpen, datasetName]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run?.log]);

  const start = (tool: ToolName) => {
    setError(null);
    const options =
      tool === 'caption'
        ? { generalThresh, charThresh, triggerWord, overwrite }
        : tool === 'prep'
          ? { buckets, outName: outName.trim() || undefined, resume }
          : {};
    apiClient
      .post('/api/datasets/tools', { datasetName, tool, options })
      .then(res => {
        setRun({
          runId: res.data.runId,
          tool,
          status: 'running',
          exitCode: null,
          log: '',
          outputName: res.data.outputName,
        });
        setPollRunId(res.data.runId);
      })
      .catch(err => setError(err?.response?.data?.error ?? 'Failed to start'));
  };

  const cancel = () => {
    if (!run || run.status !== 'running') return;
    setError(null);
    apiClient
      .delete(`/api/datasets/tools?runId=${encodeURIComponent(run.runId)}`)
      // the poller picks up the 'cancelled' status once the child has exited
      .catch(err => setError(err?.response?.data?.error ?? 'Failed to cancel'));
  };

  const busy = run?.status === 'running';

  return (
    <>
      <Button
        className="text-white bg-slate-600 px-2 sm:px-3 py-1 rounded-md mr-1 sm:mr-2 text-sm sm:text-base whitespace-nowrap"
        onClick={() => setIsOpen(true)}
      >
        <span className="hidden sm:inline">Dataset Tools</span>
        <span className="sm:hidden">Tools</span>
      </Button>
      <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title={`Dataset Tools — ${datasetName}`} size="lg">
        <div className="space-y-4 text-sm">
          {/* Pre-flight (advisory) */}
          <div className="rounded-lg border border-gray-700 p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{TOOL_LABELS.preflight}</div>
                <div className="text-xs text-gray-400">
                  Missing/empty captions, corrupt or oversized images, stray files. Advisory only — never blocks
                  training.
                </div>
              </div>
              <Button
                className="text-white bg-blue-600 px-3 py-1 rounded-md disabled:opacity-50"
                disabled={busy}
                onClick={() => start('preflight')}
              >
                Run
              </Button>
            </div>
          </div>

          {/* WD14 tagger */}
          <div className="rounded-lg border border-gray-700 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{TOOL_LABELS.caption}</div>
                <div className="text-xs text-gray-400">
                  Booru-style tags via wd-eva02-large-tagger-v3 (writes .txt sidecars; ~3 GB model download on first
                  run). Complements the VLM Auto Caption button.
                </div>
              </div>
              <Button
                className="text-white bg-blue-600 px-3 py-1 rounded-md disabled:opacity-50"
                disabled={busy}
                onClick={() => start('caption')}
              >
                Run
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberInput
                label="General threshold"
                value={generalThresh}
                onChange={v => setGeneralThresh(v ?? 0.35)}
                min={0}
                max={1}
              />
              <NumberInput
                label="Character threshold"
                value={charThresh}
                onChange={v => setCharThresh(v ?? 0.85)}
                min={0}
                max={1}
              />
              <TextInput label="Trigger word (optional)" value={triggerWord} onChange={setTriggerWord} />
              <div className="pt-5">
                <Checkbox label="Overwrite existing captions" checked={overwrite} onChange={setOverwrite} />
              </div>
            </div>
          </div>

          {/* Smart prep */}
          <div className="rounded-lg border border-gray-700 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{TOOL_LABELS.prep}</div>
                <div className="text-xs text-gray-400">
                  U2Net subject-aware crop into bucket sizes, written to a NEW dataset (source untouched). Optional —
                  the trainer already buckets; use for extreme aspect ratios.
                </div>
              </div>
              <Button
                className="text-white bg-blue-600 px-3 py-1 rounded-md disabled:opacity-50"
                disabled={busy}
                onClick={() => start('prep')}
              >
                Run
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <TextInput label="Buckets (MINxMAX, multiples of 64)" value={buckets} onChange={setBuckets} />
              <TextInput label={`Output dataset (default ${datasetName}_prepped)`} value={outName} onChange={setOutName} />
              <div className="col-span-2 text-xs text-gray-500">
                Names are lower-cased and non-alphanumerics become “_”; the log header shows the exact folder used.
              </div>
              <div className="col-span-2">
                <Checkbox
                  label="Allow existing output (resume a previous prep into it)"
                  checked={resume}
                  onChange={setResume}
                />
              </div>
            </div>
          </div>

          {error && <div className="text-red-400 text-xs">{error}</div>}

          {run && (
            <div className="rounded-lg border border-gray-700 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium">
                  {TOOL_LABELS[run.tool]}
                  {run.outputName && <span className="text-gray-400"> → {run.outputName}</span>}{' '}
                  <span className={STATUS_CLASS[run.status]}>— {STATUS_LABEL[run.status]}</span>
                </div>
                {run.status === 'running' && (
                  <Button className="text-white bg-red-700 px-3 py-1 rounded-md text-xs" onClick={cancel}>
                    Cancel
                  </Button>
                )}
              </div>
              <pre
                ref={logRef}
                className="bg-black/40 rounded p-2 text-xs whitespace-pre-wrap max-h-64 overflow-y-auto"
              >
                {run.log || '…'}
              </pre>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
