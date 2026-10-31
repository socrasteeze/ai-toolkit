'use client';

// Fork-only component (see FORK_NOTES.md). Save/load/delete training config presets
// stored as files in the presets folder. Mounted in the New Job page TopBar.

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@headlessui/react';
import { Modal } from '@/components/Modal';
import { TextInput } from '@/components/formInputs';
import { apiClient } from '@/utils/api';
import { JobConfig } from '@/types';
import useSettings from '@/hooks/useSettings';
import { configToPreset, applyPreset } from '@/utils/presets';

interface PresetInfo {
  name: string;
  fileName: string;
  updatedAt: number;
  builtIn?: boolean;
  // a built-in shadowed by the user's own copy in presets/user/
  modified?: boolean;
}

type Props = {
  jobConfig: JobConfig;
  setJobConfig: (value: any, key?: string) => void;
};

export default function PresetManager({ jobConfig, setJobConfig }: Props) {
  const { settings } = useSettings();
  const [isOpen, setIsOpen] = useState(false);
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [saveName, setSaveName] = useState('');
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  const refreshPresets = useCallback(() => {
    apiClient
      .get('/api/presets')
      .then(res => setPresets(res.data.presets ?? []))
      .catch(err => {
        console.error('Error listing presets:', err);
        setFeedback({ kind: 'error', message: 'Failed to load preset list.' });
      });
  }, []);

  useEffect(() => {
    if (isOpen) {
      setFeedback(null);
      refreshPresets();
    }
  }, [isOpen, refreshPresets]);

  const loadPreset = (name: string) => {
    setFeedback(null);
    apiClient
      .get(`/api/presets/${encodeURIComponent(name)}`)
      .then(res => {
        const updated = applyPreset(res.data.config, jobConfig, settings?.TRAINING_FOLDER);
        setJobConfig(updated);
        setIsOpen(false);
      })
      .catch(err => {
        console.error('Error loading preset:', err);
        setFeedback({ kind: 'error', message: `Failed to load preset '${name}'. Check the file format.` });
      });
  };

  const savePreset = () => {
    setFeedback(null);
    if (!saveName.trim()) {
      setFeedback({ kind: 'error', message: 'Enter a preset name.' });
      return;
    }
    apiClient
      .post('/api/presets', { name: saveName, config: configToPreset(jobConfig) })
      .then(res => {
        setFeedback({ kind: 'success', message: `Saved preset '${res.data.name}'.` });
        setSaveName('');
        refreshPresets();
      })
      .catch(err => {
        console.error('Error saving preset:', err);
        // 409 = a preset with that name already exists; the route names it and points at Overwrite
        setFeedback({ kind: 'error', message: err?.response?.data?.error ?? 'Failed to save preset.' });
      });
  };

  // Overwrite an existing preset in place with the current form's config. The POST
  // route writes by name, so this reuses the same save path as "Save as new" — the
  // only difference is the target name is an existing preset, plus a confirmation.
  // The route writes to presets/user/, so overwriting a built-in saves a copy that shadows
  // it; the shipped file is never touched. `overwrite: true` is what tells the route this
  // came through that confirmation (it refuses otherwise).
  const overwritePreset = (preset: PresetInfo) => {
    const warning = preset.builtIn
      ? `'${preset.name}' is a built-in preset. Overwrite it with your current form settings?\n\n` +
        `Your version is saved separately and replaces it in this list; the shipped file isn't ` +
        `changed. Delete your version later to restore the original.`
      : `Overwrite preset '${preset.name}' with your current form settings?`;
    if (!confirm(warning)) return;
    setFeedback(null);
    apiClient
      .post('/api/presets', { name: preset.name, config: configToPreset(jobConfig), overwrite: true })
      .then(res => {
        setFeedback({ kind: 'success', message: `Overwrote preset '${res.data.name}'.` });
        refreshPresets();
      })
      .catch(err => {
        console.error('Error overwriting preset:', err);
        setFeedback({ kind: 'error', message: `Failed to overwrite preset '${preset.name}'.` });
      });
  };

  const deletePreset = (preset: PresetInfo) => {
    const question = preset.modified
      ? `Delete your version of '${preset.name}' and restore the built-in original?`
      : `Delete preset '${preset.name}'?`;
    if (!confirm(question)) return;
    setFeedback(null);
    apiClient
      .delete(`/api/presets/${encodeURIComponent(preset.name)}`)
      .then(() => refreshPresets())
      .catch(err => {
        console.error('Error deleting preset:', err);
        setFeedback({ kind: 'error', message: err?.response?.data?.error ?? `Failed to delete preset '${preset.name}'.` });
      });
  };

  return (
    <>
      <Button className="text-gray-200 bg-gray-800 px-3 py-1 rounded-md" onClick={() => setIsOpen(true)}>
        Presets
      </Button>
      <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Training Presets" size="lg">
        <div className="min-w-0 whitespace-normal break-words">
          <div className="text-sm text-gray-400 mb-3">
            Load keeps your job name and datasets. Overwrite replaces a preset with your current settings.
          </div>

          <div className="h-12 overflow-y-auto text-sm mb-3">
            {feedback && (
              <div
                role={feedback.kind === 'error' ? 'alert' : 'status'}
                className={feedback.kind === 'error' ? 'text-red-400' : 'text-green-400'}
              >
                {feedback.message}
              </div>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto mb-4">
            {presets.length === 0 && <div className="text-sm text-gray-500 py-2">No presets yet.</div>}
            {presets.map(preset => (
              <div
                key={preset.fileName}
                className="flex items-center justify-between py-2 px-2 rounded-md hover:bg-gray-800"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-100 truncate">
                    {preset.name}
                    {preset.builtIn && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-400/80 border border-amber-400/40 rounded px-1 py-[1px]">
                        {preset.modified ? 'Built-In · Modified' : 'Built-In'}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">{new Date(preset.updatedAt).toLocaleString()}</div>
                </div>
                <div className="flex-shrink-0 flex gap-2 ml-3">
                  <Button
                    className="text-white bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded-md text-xs"
                    onClick={() => loadPreset(preset.name)}
                  >
                    Load
                  </Button>
                  <Button
                    className="text-gray-200 bg-gray-700 hover:bg-amber-700 px-3 py-1 rounded-md text-xs"
                    onClick={() => overwritePreset(preset)}
                    title="Overwrite this preset with the current form settings"
                  >
                    Overwrite
                  </Button>
                  {(!preset.builtIn || preset.modified) && (
                    <Button
                      className="text-gray-300 bg-gray-700 hover:bg-red-700 px-3 py-1 rounded-md text-xs"
                      onClick={() => deletePreset(preset)}
                      title={preset.modified ? 'Delete your version and restore the built-in' : undefined}
                    >
                      {preset.modified ? 'Restore' : 'Delete'}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-gray-800 pt-4">
            <div className="flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <TextInput
                  label="Preset Name"
                  value={saveName}
                  onChange={value => setSaveName(value)}
                  placeholder="e.g. style_lora"
                />
              </div>
              <Button
                className="text-white bg-green-600 hover:bg-green-700 px-3 py-1 rounded-md text-sm mb-[2px]"
                onClick={savePreset}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
