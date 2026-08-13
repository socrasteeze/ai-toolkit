'use client';
// Fork-only component (see FORK_NOTES.md). Breadcrumb-navigable folder browser and
// per-folder scope selector. It can point folder_path at a nested folder or keep a
// parent selected while choosing its loose files and immediate child subtrees. See
// PLAN.md's dataset-folder-browser/scope entries. Global-state modal, mirroring
// AddSingleImageModal's open.../use() convention so it needs one mount and no prop-drilling.

import { createGlobalState } from 'react-global-hooks';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { ChevronRight, Folder, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiClient } from '@/utils/api';
import { Checkbox } from '@/components/formInputs';

export interface DatasetFolderSelection {
  subPath: string;
  includeLooseFiles: boolean;
  includeSubfolders: string[] | null;
}

interface DatasetFolderPickerState {
  datasetName: string;
  initialSubPath: string;
  initialIncludeLooseFiles: boolean;
  initialIncludeSubfolders: string[] | null;
  onSelect: (selection: DatasetFolderSelection) => void;
}

interface BreadcrumbEntry {
  label: string;
  path: string;
}

interface FolderEntry {
  name: string;
  path: string;
}

export const datasetFolderPickerState = createGlobalState<DatasetFolderPickerState | null>(null);

// currentSubPath is the folder the job's dataset field is already pointed at (relative
// to the dataset root, "" for the dataset's own root) — the browser opens there so
// re-opening it shows where you last were, rather than always starting over at the top.
export const openDatasetFolderPicker = (
  datasetName: string,
  currentSubPath: string,
  includeLooseFiles: boolean,
  includeSubfolders: string[] | null,
  onSelect: (selection: DatasetFolderSelection) => void,
) => {
  datasetFolderPickerState.set({
    datasetName,
    initialSubPath: currentSubPath,
    initialIncludeLooseFiles: includeLooseFiles,
    initialIncludeSubfolders: includeSubfolders,
    onSelect,
  });
};

export default function DatasetFolderPickerModal() {
  const [info, setInfo] = datasetFolderPickerState.use();
  const open = info !== null;

  const [subPath, setSubPath] = useState('');
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([]);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeLooseFiles, setIncludeLooseFiles] = useState(true);
  const [includeAllSubfolders, setIncludeAllSubfolders] = useState(true);
  const [selectedSubfolders, setSelectedSubfolders] = useState<string[]>([]);

  // Reset navigation to wherever the field currently points every time the modal opens.
  useEffect(() => {
    if (!info) return;
    setSubPath(info.initialSubPath || '');
    setIncludeLooseFiles(info.initialIncludeLooseFiles);
    setIncludeAllSubfolders(info.initialIncludeSubfolders === null);
    setSelectedSubfolders(info.initialIncludeSubfolders ?? []);
  }, [info]);

  useEffect(() => {
    if (!info) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFolders([]);
    apiClient
      .post('/api/datasets/browse', { datasetName: info.datasetName, subPath })
      .then(res => {
        if (cancelled) return;
        setBreadcrumbs(res.data.breadcrumbs ?? []);
        setFolders(res.data.folders ?? []);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err?.response?.data?.error || 'Failed to browse folder');
        setFolders([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [info, subPath]);

  const onCancel = () => setInfo(null);

  const navigateTo = (nextSubPath: string) => {
    setSubPath(nextSubPath);
    if (info && nextSubPath === info.initialSubPath) {
      setIncludeLooseFiles(info.initialIncludeLooseFiles);
      setIncludeAllSubfolders(info.initialIncludeSubfolders === null);
      setSelectedSubfolders(info.initialIncludeSubfolders ?? []);
    } else {
      setIncludeLooseFiles(true);
      setIncludeAllSubfolders(true);
      setSelectedSubfolders([]);
    }
  };

  const toggleSubfolder = (name: string, checked: boolean) => {
    setSelectedSubfolders(current =>
      checked ? [...new Set([...current, name])] : current.filter(selected => selected !== name),
    );
  };

  const emptyScope =
    !includeLooseFiles && (folders.length === 0 || (!includeAllSubfolders && selectedSubfolders.length === 0));

  const onSelectCurrent = () => {
    if (info && !emptyScope) {
      info.onSelect({
        subPath,
        includeLooseFiles,
        includeSubfolders: includeAllSubfolders ? null : selectedSubfolders,
      });
      setInfo(null);
    }
  };

  return (
    <Dialog open={open} onClose={onCancel} className="relative z-10">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-gray-900/75 transition-opacity data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in"
      />

      <div className="fixed inset-0 z-10 w-screen overflow-y-auto">
        <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
          <DialogPanel
            transition
            className="relative transform overflow-hidden rounded-lg bg-gray-800 text-left shadow-xl transition-all data-closed:translate-y-4 data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in sm:my-8 sm:w-full sm:max-w-lg data-closed:sm:translate-y-0 data-closed:sm:scale-95"
          >
            <div className="bg-gray-800 px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
              <DialogTitle as="h3" className="text-base font-semibold text-gray-200 mb-3">
                Browse and Scope Dataset Folder
              </DialogTitle>

              {/* Breadcrumb trail: click any segment to jump back up to it */}
              <div className="flex flex-wrap items-center gap-1 text-sm mb-3 text-gray-400">
                {breadcrumbs.map((crumb, i) => (
                  <span key={crumb.path} className="flex items-center gap-1">
                    {i > 0 && <ChevronRight className="w-3 h-3" />}
                    <button
                      type="button"
                      onClick={() => navigateTo(crumb.path)}
                      className={
                        crumb.path === subPath
                          ? 'text-gray-200 font-medium cursor-default'
                          : 'text-blue-400 hover:text-blue-300 underline'
                      }
                      disabled={crumb.path === subPath}
                    >
                      {crumb.label}
                    </button>
                  </span>
                ))}
              </div>

              <div className="border border-gray-700 rounded-md max-h-72 overflow-y-auto bg-gray-900/40">
                {loading && (
                  <div className="flex items-center justify-center gap-2 text-gray-400 text-sm py-6">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                  </div>
                )}
                {!loading && error && <div className="text-rose-400 text-sm p-4">{error}</div>}
                {!loading && !error && folders.length === 0 && (
                  <div className="text-gray-500 text-sm p-4">No subfolders here.</div>
                )}
                {!loading &&
                  !error &&
                  folders.map(folder => (
                    <button
                      key={folder.path}
                      type="button"
                      onClick={() => navigateTo(folder.path)}
                      className="w-full flex items-center gap-2 text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-700/60 border-b border-gray-800 last:border-b-0"
                    >
                      <Folder className="w-4 h-4 text-amber-400 shrink-0" />
                      {folder.name}
                    </button>
                  ))}
              </div>

              {!loading && !error && (
                <div className="mt-4 border border-gray-700 rounded-md p-3 bg-gray-900/40 space-y-3">
                  <div>
                    <div className="text-sm font-medium text-gray-200">Selection scope</div>
                    <div className="text-xs text-gray-500 mt-1">
                      A selected child folder includes its full subtree. Navigating into a child and selecting it
                      excludes parent loose files and sibling folders.
                    </div>
                  </div>
                  <Checkbox
                    label="Include loose files in this folder"
                    checked={includeLooseFiles}
                    onChange={setIncludeLooseFiles}
                  />
                  {folders.length > 0 && (
                    <>
                      <Checkbox
                        label="Include every child folder"
                        checked={includeAllSubfolders}
                        onChange={checked => {
                          setIncludeAllSubfolders(checked);
                          if (!checked) setSelectedSubfolders(folders.map(folder => folder.name));
                        }}
                      />
                      {!includeAllSubfolders && (
                        <div className="pl-4 space-y-2 border-l border-gray-700">
                          {folders.map(folder => (
                            <Checkbox
                              key={folder.path}
                              label={folder.name}
                              checked={selectedSubfolders.includes(folder.name)}
                              onChange={checked => toggleSubfolder(folder.name, checked)}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  {emptyScope && <div className="text-xs text-rose-400">Select at least one file source.</div>}
                </div>
              )}
            </div>
            <div className="bg-gray-700 px-4 py-3 sm:flex sm:flex-row-reverse sm:px-6 gap-2">
              <button
                type="button"
                onClick={onSelectCurrent}
                disabled={emptyScope}
                className="mt-3 inline-flex w-full justify-center rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed sm:mt-0 sm:w-auto"
              >
                Select this folder
              </button>
              <button
                type="button"
                data-autofocus
                onClick={onCancel}
                className="mt-3 inline-flex w-full justify-center rounded-md bg-gray-800 px-3 py-2 text-sm font-semibold text-gray-200 hover:bg-gray-800 sm:mt-0 sm:w-auto ring-0"
              >
                Cancel
              </button>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
