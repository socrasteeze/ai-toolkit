// Fork-only (see FORK_NOTES.md, 2026-10-12). Peer (remote GPU) jobs stage exactly one dataset
// folder per dataset entry (startRemoteJob.ts stageDataset). The trainer also accepts a LIST in
// folder_path and a dataset_path key (config_modules.py splits those into one dataset per path,
// pairable with train.pool_datasets) - none of that is staged, so the peer would train against
// paths that do not exist there. Refuse up front, before anything is copied.

export const PEER_SINGLE_FOLDER_ERROR =
  'Peer jobs support only a single dataset folder per dataset (one folder_path string, no dataset_path). Run multi-folder or pooled datasets locally.';

const present = (v: unknown): boolean =>
  (typeof v === 'string' && v.trim() !== '') || (Array.isArray(v) && v.length > 0);

export const assertPeerDatasetsSupported = (datasets: unknown): void => {
  if (!Array.isArray(datasets)) return;
  datasets.forEach((d: any, i: number) => {
    if (Array.isArray(d?.folder_path)) {
      throw new Error(`Dataset ${i + 1} lists several folders in folder_path. ${PEER_SINGLE_FOLDER_ERROR}`);
    }
    if (present(d?.dataset_path)) {
      throw new Error(`Dataset ${i + 1} uses dataset_path. ${PEER_SINGLE_FOLDER_ERROR}`);
    }
  });
};
