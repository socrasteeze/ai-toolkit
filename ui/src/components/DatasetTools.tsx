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

type ToolName = 'preflight' | 'caption' | 'prep';

interface ToolRun {
  runId: string;
  tool: ToolName;
  status: 'running' | 'done' | 'failed';
  exitCode: number | null;
  log: string;
}

type Props = {
  datasetName: string;
  onDatasetChanged?: () => void;
};

const TOOL_LABELS: Record<ToolName, string> = {
  preflight: 'Pre-flight Check',
  caption: 'WD14 Auto-Tag',
  prep: 'Smart Resize/Crop',
};

export default function DatasetTools({ datasetName, onDatasetChanged }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [run, setRun] = useState<ToolRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  // WD14 options
  const [generalThresh, setGeneralThresh] = useState(0.35);
  const [charThresh, setCharThresh] = useState(0.85);
  const [triggerWord, setTriggerWord] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  // prep options
  const [buckets, setBuckets] = useState('512x768');
  const [outName, setOutName] = useState('');

  const logRef = useRef<HTMLPreElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const poll = useCallback(
    (runId: string) => {
      stopPolling();
      pollRef.current = setInterval(() => {
        apiClient
          .get(`/api/datasets/tools?runId=${encodeURIComponent(runId)}`)
          .then(res => {
            const r: ToolRun | null = res.data.run;
            if (!r) return;
            setRun({ ...r });
            if (r.status !== 'running') {
              stopPolling();
              if (r.tool !== 'preflight' && onDatasetChanged) onDatasetChanged();
            }
          })
          .catch(() => stopPolling());
      }, 1000);
    },
    [onDatasetChanged],
  );

  // resume watching an in-flight run if the modal is reopened
  useEffect(() => {
    if (!isOpen) {
      stopPolling();
      return;
    }
    apiClient.get(`/api/datasets/tools?datasetName=${encodeURIComponent(datasetName)}`).then(res => {
      const r: ToolRun | null = res.data.run;
      if (r) {
        setRun(r);
        if (r.status === 'running') poll(r.runId);
      }
    });
    return stopPolling;
  }, [isOpen, datasetName, poll]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run?.log]);

  const start = (tool: ToolName) => {
    setError(null);
    const options =
      tool === 'caption'
        ? { generalThresh, charThresh, triggerWord, overwrite }
        : tool === 'prep'
          ? { buckets, outName: outName.trim() || undefined }
          : {};
    apiClient
      .post('/api/datasets/tools', { datasetName, tool, options })
      .then(res => {
        setRun({ runId: res.data.runId, tool, status: 'running', exitCode: null, log: '' });
        poll(res.data.runId);
      })
      .catch(err => setError(err?.response?.data?.error ?? 'Failed to start'));
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
            </div>
          </div>

          {error && <div className="text-red-400 text-xs">{error}</div>}

          {run && (
            <div className="rounded-lg border border-gray-700 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium">
                  {TOOL_LABELS[run.tool]}{' '}
                  <span
                    className={
                      run.status === 'running'
                        ? 'text-yellow-400'
                        : run.status === 'done'
                          ? 'text-green-400'
                          : 'text-red-400'
                    }
                  >
                    — {run.status === 'running' ? 'running…' : run.status === 'done' ? 'finished' : 'failed'}
                  </span>
                </div>
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
