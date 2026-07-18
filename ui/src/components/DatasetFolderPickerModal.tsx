'use client';
// Fork-only component (see FORK_NOTES.md). Breadcrumb-navigable folder browser for
// picking a nested folder inside a dataset (e.g. "Dataset/Folder 1/Folder 1a") as a
// job's dataset folder_path, instead of only the top-level dataset. See PLAN.md's
// dataset-folder-browser entry for the full rationale. Global-state modal, mirroring
// AddSingleImageModal's open.../use() convention so it needs only one mount point and
// no prop-drilling.

import { createGlobalState } from 'react-global-hooks';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { ChevronRight, Folder, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiClient } from '@/utils/api';

interface DatasetFolderPickerState {
  datasetName: string;
  initialSubPath: string;
  onSelect: (subPath: string) => void;
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
  onSelect: (subPath: string) => void,
) => {
  datasetFolderPickerState.set({ datasetName, initialSubPath: currentSubPath, onSelect });
};

export default function DatasetFolderPickerModal() {
  const [info, setInfo] = datasetFolderPickerState.use();
  const open = info !== null;

  const [subPath, setSubPath] = useState('');
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([]);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset navigation to wherever the field currently points every time the modal opens.
  useEffect(() => {
    if (info) setSubPath(info.initialSubPath || '');
  }, [info]);

  useEffect(() => {
    if (!info) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
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

  const onSelectCurrent = () => {
    if (info) {
      info.onSelect(subPath);
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
                Browse Dataset Folder
              </DialogTitle>

              {/* Breadcrumb trail: click any segment to jump back up to it */}
              <div className="flex flex-wrap items-center gap-1 text-sm mb-3 text-gray-400">
                {breadcrumbs.map((crumb, i) => (
                  <span key={crumb.path} className="flex items-center gap-1">
                    {i > 0 && <ChevronRight className="w-3 h-3" />}
                    <button
                      type="button"
                      onClick={() => setSubPath(crumb.path)}
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
                      onClick={() => setSubPath(folder.path)}
                      className="w-full flex items-center gap-2 text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-700/60 border-b border-gray-800 last:border-b-0"
                    >
                      <Folder className="w-4 h-4 text-amber-400 shrink-0" />
                      {folder.name}
                    </button>
                  ))}
              </div>
            </div>
            <div className="bg-gray-700 px-4 py-3 sm:flex sm:flex-row-reverse sm:px-6 gap-2">
              <button
                type="button"
                onClick={onSelectCurrent}
                className="mt-3 inline-flex w-full justify-center rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 sm:mt-0 sm:w-auto"
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
