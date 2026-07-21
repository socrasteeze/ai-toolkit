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
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshPresets = useCallback(() => {
    apiClient
      .get('/api/presets')
      .then(res => setPresets(res.data.presets ?? []))
      .catch(err => {
        console.error('Error listing presets:', err);
        setError('Failed to load preset list.');
      });
  }, []);

  useEffect(() => {
    if (isOpen) {
      setStatus(null);
      setError(null);
      refreshPresets();
    }
  }, [isOpen, refreshPresets]);

  const loadPreset = (name: string) => {
    setError(null);
    apiClient
      .get(`/api/presets/${encodeURIComponent(name)}`)
      .then(res => {
        const updated = applyPreset(res.data.config, jobConfig, settings?.TRAINING_FOLDER);
        setJobConfig(updated);
        setIsOpen(false);
      })
      .catch(err => {
        console.error('Error loading preset:', err);
        setError(`Failed to load preset '${name}'. Check the file format.`);
      });
  };

  const savePreset = () => {
    if (!saveName.trim()) {
      setError('Enter a name for the preset.');
      return;
    }
    setError(null);
    apiClient
      .post('/api/presets', { name: saveName, config: configToPreset(jobConfig) })
      .then(res => {
        setStatus(`Saved preset '${res.data.name}'.`);
        setSaveName('');
        refreshPresets();
      })
      .catch(err => {
        console.error('Error saving preset:', err);
        setError('Failed to save preset.');
      });
  };

  // Overwrite an existing preset in place with the current form's config. The POST
  // route writes by name, so this reuses the same save path as "Save as new" — the
  // only difference is the target name is an existing preset, plus a confirmation.
  // Built-in (shipped, provenance-tracked) presets get a stronger warning, but the
  // write is never blocked — the user asked for it explicitly.
  const overwritePreset = (preset: PresetInfo) => {
    const warning = preset.builtIn
      ? `'${preset.name}' is a BUILT-IN recipe shipped with the fork (tracked in git and the ` +
        `preset-alignment doc). Overwrite it with your current form settings?\n\n` +
        `Tip: to keep the original, use "Save current config as preset" below with a new name instead.`
      : `Overwrite preset '${preset.name}' with your current form settings?`;
    if (!confirm(warning)) return;
    setError(null);
    apiClient
      .post('/api/presets', { name: preset.name, config: configToPreset(jobConfig) })
      .then(res => {
        setStatus(`Overwrote preset '${res.data.name}'.`);
        refreshPresets();
      })
      .catch(err => {
        console.error('Error overwriting preset:', err);
        setError(`Failed to overwrite preset '${preset.name}'.`);
      });
  };

  const deletePreset = (name: string) => {
    if (!confirm(`Delete preset '${name}'?`)) return;
    apiClient
      .delete(`/api/presets/${encodeURIComponent(name)}`)
      .then(() => refreshPresets())
      .catch(err => {
        console.error('Error deleting preset:', err);
        setError(`Failed to delete preset '${name}'.`);
      });
  };

  return (
    <>
      <Button className="text-gray-200 bg-gray-800 px-3 py-1 rounded-md" onClick={() => setIsOpen(true)}>
        Presets
      </Button>
      <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Training Presets" size="lg">
        <div className="text-sm text-gray-400 mb-3">
          Loading a preset applies its training recipe but keeps the current job name and dataset selections.
          <span className="text-gray-300"> Overwrite</span> writes your current form settings back over a preset
          (built-ins warn first). Preset files live in the <span className="font-mono">presets</span> folder — drop
          in any ai-toolkit config (JSON/YAML) to add it here.
        </div>

        {error && <div className="text-sm text-red-400 mb-2">{error}</div>}
        {status && <div className="text-sm text-green-400 mb-2">{status}</div>}

        <div className="max-h-72 overflow-y-auto mb-4">
          {presets.length === 0 && <div className="text-sm text-gray-500 py-2">No presets yet.</div>}
          {presets.map(preset => (
            <div
              key={preset.fileName}
              className="flex items-center justify-between py-2 px-2 rounded-md hover:bg-gray-800"
            >
              <div className="min-w-0">
                <div className="text-sm text-gray-100 truncate">
                  {preset.name}
                  {preset.builtIn && (
                    <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-400/80 border border-amber-400/40 rounded px-1 py-[1px]">
                      built-in
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
                <Button
                  className="text-gray-300 bg-gray-700 hover:bg-red-700 px-3 py-1 rounded-md text-xs"
                  onClick={() => deletePreset(preset.name)}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-gray-800 pt-4">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <TextInput
                label="Save current config as preset"
                value={saveName}
                onChange={value => setSaveName(value)}
                placeholder="eg. illustriousxl_character_lora"
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
      </Modal>
    </>
  );
}
