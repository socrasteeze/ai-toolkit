'use client';

/**
 * Manage the machines this install can send jobs to.
 *
 * A peer is an ordinary ai-toolkit install reachable over the network. Nothing
 * is installed on it — it only needs to be running, and to allow this machine
 * through its firewall. Its GPUs then appear in the job form's GPU picker.
 *
 * The access token is write-only from here: the server never sends a stored
 * token back to the browser, and an entry saved with the field left blank keeps
 * whatever token it already had (see `savePeers`). Clearing one is done by
 * removing the machine and adding it again.
 */

import { useEffect, useState } from 'react';
import { apiClient } from '@/utils/api';
import { PEER_ID_PATTERN } from '@/utils/gpuIds';

interface MachineRow {
  id: string;
  label: string;
  url: string;
  online: boolean;
  error?: string;
  gpus: { index: number; name: string }[];
  /** Only set while adding; never returned by the server. */
  token?: string;
}

const inputClasses =
  'w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-gray-600 focus:border-transparent';

export default function PeerSettings() {
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'success' | 'error'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState({ id: '', label: '', url: '', token: '' });

  const load = async () => {
    setStatus('loading');
    try {
      const data = await apiClient.get('/api/machines').then(res => res.data);
      setMachines(Array.isArray(data?.machines) ? data.machines : []);
      setStatus('idle');
    } catch (e) {
      console.error('Could not load machines:', e);
      setStatus('error');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const persist = async (next: MachineRow[]) => {
    setStatus('saving');
    setProblem(null);
    try {
      await apiClient.post('/api/machines', {
        peers: next.map(m => ({ id: m.id, label: m.label, url: m.url, ...(m.token ? { token: m.token } : {}) })),
      });
      await load();
      setStatus('success');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (e) {
      console.error('Could not save machines:', e);
      setStatus('error');
    }
  };

  const add = async () => {
    const id = draft.id.trim().toLowerCase();
    const url = draft.url.trim().replace(/\/+$/, '');
    if (!PEER_ID_PATTERN.test(id)) {
      setProblem('The short name must be lowercase letters, numbers, dashes or underscores — and no colons.');
      return;
    }
    if (machines.some(m => m.id === id)) {
      setProblem(`There is already a machine called "${id}".`);
      return;
    }
    if (!/^https?:\/\//.test(url)) {
      setProblem('The address must start with http:// or https://');
      return;
    }
    await persist([
      ...machines,
      { id, label: draft.label.trim() || id, url, online: false, gpus: [], token: draft.token.trim() || undefined },
    ]);
    setDraft({ id: '', label: '', url: '', token: '' });
  };

  const remove = async (id: string) => {
    await persist(machines.filter(m => m.id !== id));
  };

  return (
    <div className="mt-8">
      <h2 className="text-base font-medium mb-1">Other machines</h2>
      <p className="text-gray-500 text-sm mb-4">
        Another computer running AI Toolkit, whose GPUs you want to train on. Its GPUs appear in the GPU picker when
        you create a job. The dataset and config are sent over; base models are downloaded by that machine itself, so
        it needs its own Hugging Face token and models folder set up.
      </p>

      {machines.length === 0 && status !== 'loading' && (
        <p className="text-gray-500 text-sm mb-4">No other machines yet. Everything runs on this one.</p>
      )}

      <div className="space-y-2 mb-4">
        {machines.map(machine => (
          <div key={machine.id} className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">
                {machine.label} <span className="text-gray-600">({machine.id})</span>
              </div>
              <div className="text-xs text-gray-500 truncate">{machine.url}</div>
            </div>
            <div className="text-xs whitespace-nowrap">
              {machine.online ? (
                <span className="text-green-500">
                  {machine.gpus.length} GPU{machine.gpus.length === 1 ? '' : 's'}
                </span>
              ) : (
                <span className="text-orange-700">{machine.error ?? 'offline'}</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => remove(machine.id)}
              className="text-xs px-2 py-1 rounded-md bg-gray-800 hover:bg-gray-700"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          className={inputClasses}
          placeholder="Short name (e.g. workshop)"
          value={draft.id}
          onChange={e => setDraft({ ...draft, id: e.target.value })}
        />
        <input
          className={inputClasses}
          placeholder="Display name (e.g. Workshop PC)"
          value={draft.label}
          onChange={e => setDraft({ ...draft, label: e.target.value })}
        />
        <input
          className={inputClasses}
          placeholder="Address (e.g. http://192.0.2.20:8675)"
          value={draft.url}
          onChange={e => setDraft({ ...draft, url: e.target.value })}
        />
        <input
          className={inputClasses}
          type="password"
          placeholder="Its access token (leave blank if it has none)"
          value={draft.token}
          onChange={e => setDraft({ ...draft, token: e.target.value })}
        />
      </div>

      {problem && <p className="text-red-500 text-sm mt-2">{problem}</p>}
      {status === 'error' && <p className="text-red-500 text-sm mt-2">Could not reach this server to save. Try again.</p>}
      {status === 'success' && <p className="text-green-500 text-sm mt-2">Saved.</p>}

      <button
        type="button"
        onClick={add}
        disabled={status === 'saving'}
        className="mt-3 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors disabled:opacity-50"
      >
        {status === 'saving' ? 'Saving…' : 'Add machine'}
      </button>
    </div>
  );
}
