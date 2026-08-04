/**
 * Runs a job on another machine's GPU.
 *
 * Reached from `startJob.ts` when `job.gpu_ids` names a peer (see `cron/gpuIds.ts`).
 * The peer is an unmodified ai-toolkit install: every call below is a route it
 * already serves. Nothing is installed there, and it needs no knowledge of this
 * file -- it just sees an ordinary job appear in its own queue and UI.
 *
 * What crosses the wire, and what deliberately does not:
 *
 *   dataset images + captions   -> staged to the peer, incrementally
 *   the job config              -> rewritten for the peer's own folders
 *   base model weights          -> NEVER. The peer downloads its own, with its
 *                                  own HF_TOKEN and MODELS_PATH. These are the
 *                                  largest files involved and they are the same
 *                                  bytes on both machines.
 *   log, samples, checkpoints   -> mirrored home as the run progresses
 *
 * The mirror writes the SAME `Job` row and the SAME
 * `{TRAINING_FOLDER}/{job.name}/` folder a local run would, which is why no UI
 * code changes: the job page, log tail, sample grid and file list keep working
 * against a remote run without knowing it is remote.
 */

import fs from 'fs';
import path from 'path';
import { Job } from '@prisma/client';
import prisma from '../prisma';
import { getTrainingFolder } from '../paths';
import { splitPeerGpu } from '../gpuIds';
import { getPeer, Peer } from '../peers';
import { PeerError, peerDownloadFile, peerJson, peerUploadFiles } from '../remoteClient';

/** How often the hub asks the peer how the run is going. Matches the UI's own 5s job poll. */
const WATCH_INTERVAL_MS = 5_000;

/** Files uploaded per multipart request. Matches what the sibling project settled on. */
const UPLOAD_BATCH = 8;

/** Written into the staged folder so the next run can tell what is already there. */
const MANIFEST_NAME = '.hub_manifest.json';

/** Everything a dataset folder legitimately contains, flat. */
const DATASET_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.webp', '.bmp',
  '.mp4', '.avi', '.mov', '.mkv', '.wmv', '.m4v', '.flv',
  '.mp3', '.wav', '.flac', '.ogg',
  '.txt', '.json', '.caption',
];

/* Every way a run can END on the peer, taken from the trainer rather than from
 * `JobStatus`: `UITrainer.update_status` writes `completed` on a clean finish,
 * and `stopped` / `error` on the other two. `completed` was missing here, which
 * meant the SUCCESS case was the one the watcher did not recognise — it would
 * have polled a finished job forever and never mirrored its checkpoints home,
 * while the local UI sat on a job row that said `completed` with no weights
 * beside it. `queued`, `running` and `stopping` are the transient ones. */
const TERMINAL_STATUSES = ['completed', 'stopped', 'error'];

async function markJobError(jobID: string, message: string): Promise<void> {
  try {
    await prisma.job.update({
      where: { id: jobID },
      data: { status: 'error', info: message.slice(0, 4000), stop: false },
    });
  } catch (e) {
    console.error(`Could not record the failure of job ${jobID}:`, e);
  }
}

/**
 * Joins a path the way the PEER would.
 *
 * The peer's roots come back as absolute strings from its own settings, so the
 * hub can be Linux while the peer is Windows. Inferring the separator from the
 * root the peer reported is the only thing that works in both directions --
 * `path.join` here would use the HUB's separator and build a path the peer
 * cannot open.
 */
function joinRemote(root: string, ...parts: string[]): string {
  const sep = root.includes('\\') || /^[A-Za-z]:/.test(root) ? '\\' : '/';
  const trimmed = root.replace(/[\\/]+$/, '');
  return [trimmed, ...parts].join(sep);
}

/** A stable, filesystem-safe dataset name on the peer, one per job per dataset slot. */
function stagedDatasetName(jobName: string, index: number): string {
  const safe = jobName.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `hub_${safe}_${index}`;
}

interface StagedFile {
  localPath: string;
  name: string;
  /** size:mtimeMs -- changes whenever the file is edited, so an edit re-sends it. */
  signature: string;
}

/**
 * Every file in a dataset folder, with a change signature.
 *
 * Subfolders are refused rather than flattened. The peer's upload route writes
 * every file into one directory, so a nested layout (an ai-toolkit `_controls`
 * folder, or per-bucket subdirectories) would silently collapse into a
 * different dataset than the one that was configured. Failing here, before
 * anything is uploaded, is the honest outcome.
 */
async function collectDatasetFiles(folder: string): Promise<StagedFile[]> {
  const entries = await fs.promises.readdir(folder, { withFileTypes: true });
  const files: StagedFile[] = [];
  const subdirs: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isDirectory()) {
      subdirs.push(entry.name);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!DATASET_EXTENSIONS.includes(ext)) {
      continue;
    }
    const localPath = path.join(folder, entry.name);
    const stat = await fs.promises.stat(localPath);
    files.push({
      localPath,
      // Pre-apply the peer's own sanitizer so the manifest records the name the
      // file will actually have there; otherwise every run sees a mismatch and
      // re-uploads the whole dataset.
      name: entry.name.replace(/[^a-zA-Z0-9.-]/g, '_'),
      signature: `${stat.size}:${Math.round(stat.mtimeMs)}`,
    });
  }

  if (subdirs.length > 0) {
    throw new Error(
      `Dataset folder "${folder}" has subfolders (${subdirs.slice(0, 3).join(', ')}${subdirs.length > 3 ? ', …' : ''}). ` +
        `Running on another machine stages a flat folder only — move these images up a level, or run this job locally.`,
    );
  }
  return files;
}

/** The manifest the last staging left behind, or an empty one. */
async function readRemoteManifest(peer: Peer, remoteDir: string): Promise<Record<string, string>> {
  try {
    const res = await peerJson<Record<string, string>>(
      peer,
      `/api/files/${encodeURIComponent(joinRemote(remoteDir, MANIFEST_NAME))}`,
      {},
      20_000,
    );
    return res && typeof res === 'object' ? res : {};
  } catch {
    // No manifest is the normal first-run case, and a corrupt one only costs a
    // full re-upload — neither is worth failing the job over.
    return {};
  }
}

/**
 * Uploads whatever the peer does not already hold, and returns the peer-side
 * folder to point the config at.
 *
 * The manifest is uploaded LAST, after the files it describes. Its presence is
 * therefore the marker that staging completed: an interrupted staging leaves
 * the previous (smaller) manifest, so the next run re-sends the gap rather than
 * trusting a half-written list.
 */
async function stageDataset(
  peer: Peer,
  peerDatasetsRoot: string,
  jobName: string,
  index: number,
  localFolder: string,
  onProgress: (message: string) => Promise<void>,
): Promise<string> {
  const datasetName = stagedDatasetName(jobName, index);
  const remoteDir = joinRemote(peerDatasetsRoot, datasetName);

  const files = await collectDatasetFiles(localFolder);
  if (files.length === 0) {
    throw new Error(`Dataset folder "${localFolder}" has no images to send.`);
  }

  const previous = await readRemoteManifest(peer, remoteDir);
  const toSend = files.filter(f => previous[f.name] !== f.signature);

  const manifest: Record<string, string> = {};
  for (const file of files) {
    manifest[file.name] = file.signature;
  }

  if (toSend.length === 0) {
    await onProgress(`${peer.label} already has all ${files.length} files`);
    return remoteDir;
  }

  await onProgress(`Sending ${toSend.length} of ${files.length} files to ${peer.label}…`);
  for (let i = 0; i < toSend.length; i += UPLOAD_BATCH) {
    const batch = toSend.slice(i, i + UPLOAD_BATCH);
    await peerUploadFiles(peer, datasetName, batch);
    await onProgress(`Sending files to ${peer.label} (${Math.min(i + UPLOAD_BATCH, toSend.length)}/${toSend.length})…`);
  }

  const manifestPath = path.join(await tmpDir(), `${datasetName}.manifest.json`);
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');
  try {
    await peerUploadFiles(peer, datasetName, [{ localPath: manifestPath, name: MANIFEST_NAME }]);
  } finally {
    await fs.promises.rm(manifestPath, { force: true });
  }

  return remoteDir;
}

async function tmpDir(): Promise<string> {
  const dir = path.join(await getTrainingFolder(), '.hub_staging');
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

/** The peer's own folder roots. This is the whole handshake. */
async function peerSettings(peer: Peer): Promise<{ trainingFolder: string; datasetsFolder: string }> {
  const settings = await peerJson<Record<string, string>>(peer, '/api/settings', {}, 15_000);
  const trainingFolder = settings?.TRAINING_FOLDER;
  const datasetsFolder = settings?.DATASETS_FOLDER;
  if (!trainingFolder || !datasetsFolder) {
    throw new PeerError(`${peer.label} did not report its training and dataset folders`, peer.id);
  }
  return { trainingFolder, datasetsFolder };
}

/**
 * Finds this job on the peer, or creates it.
 *
 * Re-running a job the peer already knows must reuse its row rather than fail
 * on the unique-name constraint — otherwise a second run of any job is
 * permanently blocked until someone deletes it there by hand.
 */
async function upsertRemoteJob(peer: Peer, name: string, gpuIds: string, jobConfig: any): Promise<string> {
  const existing = await peerJson<{ jobs: { id: string; name: string }[] }>(peer, '/api/jobs', {}, 30_000);
  const match = existing?.jobs?.find(j => j.name === name);
  const body: any = { name, gpu_ids: gpuIds, job_config: jobConfig };
  if (match) {
    body.id = match.id;
  }
  const saved = await peerJson<{ id: string }>(
    peer,
    '/api/jobs',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    60_000,
  );
  if (!saved?.id) {
    throw new PeerError(`${peer.label} accepted the job but returned no id`, peer.id);
  }
  return saved.id;
}

export default async function startRemoteJob(job: Job): Promise<void> {
  const jobID = job.id;
  const split = splitPeerGpu(job.gpu_ids);
  if (!split) {
    await markJobError(jobID, `Could not read a machine out of "${job.gpu_ids}"`);
    return;
  }

  const peer = await getPeer(split.peerId);
  if (!peer) {
    await markJobError(jobID, `Machine "${split.peerId}" is no longer configured. Add it again, or pick another GPU.`);
    return;
  }

  const setInfo = async (info: string): Promise<void> => {
    try {
      await prisma.job.update({ where: { id: jobID }, data: { info: info.slice(0, 4000) } });
    } catch {
      // A status line is never worth failing a run for.
    }
  };

  try {
    const trainingRoot = await getTrainingFolder();
    const trainingFolder = path.join(trainingRoot, job.name);
    await fs.promises.mkdir(trainingFolder, { recursive: true });

    // Same log rotation a local run does, so the job folder looks identical
    // whichever machine produced it.
    const logPath = path.join(trainingFolder, 'log.txt');
    if (fs.existsSync(logPath)) {
      const logsFolder = path.join(trainingFolder, 'logs');
      await fs.promises.mkdir(logsFolder, { recursive: true });
      let num = 0;
      while (fs.existsSync(path.join(logsFolder, `${num}_log.txt`))) {
        num++;
      }
      await fs.promises.rename(logPath, path.join(logsFolder, `${num}_log.txt`));
    }
    await fs.promises.writeFile(logPath, `Running on ${peer.label} (${peer.url}), GPU ${split.localGpuIds}\n`, 'utf-8');

    await setInfo(`Connecting to ${peer.label}…`);
    const remote = await peerSettings(peer);

    const jobConfig = JSON.parse(job.job_config);
    const process0 = jobConfig?.config?.process?.[0];
    if (!process0) {
      throw new Error('This job config has no process block to run.');
    }

    // Stage every dataset and repoint it at the peer's copy.
    const datasets = Array.isArray(process0.datasets) ? process0.datasets : [];
    for (let i = 0; i < datasets.length; i++) {
      const localFolder = datasets[i]?.folder_path;
      if (typeof localFolder !== 'string' || localFolder.trim() === '') {
        continue;
      }
      datasets[i].folder_path = await stageDataset(peer, remote.datasetsFolder, job.name, i, localFolder, setInfo);
      // Control images live beside the dataset and are not staged; refuse rather
      // than train against a path that does not exist on the peer.
      if (typeof datasets[i].control_path === 'string' && datasets[i].control_path.trim() !== '') {
        throw new Error('Datasets with a control path cannot run on another machine yet. Run this job locally.');
      }
    }

    // The peer's own output root. Its `startJob` overwrites `sqlite_db_path`
    // with its own database, so that one is deliberately left alone.
    process0.training_folder = remote.trainingFolder;

    await setInfo(`Queuing on ${peer.label}…`);
    const remoteJobID = await upsertRemoteJob(peer, job.name, split.localGpuIds, jobConfig);

    await peerJson(peer, `/api/jobs/${remoteJobID}/start`, {}, 30_000);
    await peerJson(peer, `/api/queue/${encodeURIComponent(split.localGpuIds)}/start`, {}, 30_000);

    await prisma.job.update({
      where: { id: jobID },
      data: { status: 'running', info: `Running on ${peer.label}`, stop: false, return_to_queue: false },
    });

    await watchRemoteJob(job, peer, remoteJobID, trainingFolder, logPath);
  } catch (e: any) {
    const message = e instanceof PeerError || e instanceof Error ? e.message : String(e);
    console.error(`Remote job ${jobID} failed:`, e);
    await markJobError(jobID, message);
  }
}

/**
 * Follows the run on the peer and mirrors it home until it ends.
 *
 * Nothing here fabricates a result. If the peer becomes unreachable the row
 * says so and names the machine; if the peer reports an error, its own message
 * is carried across verbatim.
 */
async function watchRemoteJob(
  job: Job,
  peer: Peer,
  remoteJobID: string,
  trainingFolder: string,
  logPath: string,
): Promise<void> {
  const jobID = job.id;
  const samplesFolder = path.join(trainingFolder, 'samples');
  let logOffset = 0;
  const haveSamples = new Set<string>();
  let stopSent = false;
  let consecutiveFailures = 0;

  for (;;) {
    await new Promise(resolve => setTimeout(resolve, WATCH_INTERVAL_MS));

    // Has anything on this side asked the run to end?
    const local = await prisma.job.findUnique({ where: { id: jobID } });
    if (!local) {
      return;
    }
    if ((local.stop || local.return_to_queue) && !stopSent) {
      stopSent = true;
      try {
        await peerJson(peer, `/api/jobs/${remoteJobID}/stop`, {}, 30_000);
        await prisma.job.update({ where: { id: jobID }, data: { info: `Stopping on ${peer.label}…` } });
      } catch (e: any) {
        console.error(`Could not forward the stop to ${peer.label}:`, e);
      }
    }

    let remoteJob: any;
    try {
      remoteJob = await peerJson(peer, `/api/jobs?id=${encodeURIComponent(remoteJobID)}`, {}, 20_000);
      consecutiveFailures = 0;
    } catch (e: any) {
      consecutiveFailures++;
      // A peer that reboots or drops off the network for a moment should not
      // kill a multi-hour run; one that is gone for minutes is a real failure.
      if (consecutiveFailures >= 12) {
        await markJobError(jobID, `Lost contact with ${peer.label}: ${e?.message ?? e}`);
        return;
      }
      await prisma.job
        .update({ where: { id: jobID }, data: { info: `${peer.label} is not answering (attempt ${consecutiveFailures})…` } })
        .catch(() => {});
      continue;
    }

    if (!remoteJob) {
      await markJobError(jobID, `${peer.label} no longer has this job. It may have been deleted there.`);
      return;
    }

    await mirrorLog(peer, remoteJobID, logPath, logOffset).then(next => {
      logOffset = next;
    });
    await mirrorSamples(peer, remoteJobID, samplesFolder, haveSamples);

    await prisma.job
      .update({
        where: { id: jobID },
        data: {
          status: remoteJob.status === 'queued' ? 'running' : remoteJob.status,
          step: remoteJob.step ?? 0,
          total_steps: remoteJob.total_steps ?? null,
          speed_string: remoteJob.speed_string ?? '',
          info:
            remoteJob.status === 'running' || remoteJob.status === 'queued'
              ? `${remoteJob.info || 'Training'} — on ${peer.label}`
              : remoteJob.info || '',
        },
      })
      .catch(() => {});

    if (TERMINAL_STATUSES.includes(remoteJob.status)) {
      await mirrorLog(peer, remoteJobID, logPath, logOffset);
      await mirrorSamples(peer, remoteJobID, samplesFolder, haveSamples);
      await mirrorCheckpoints(peer, remoteJobID, trainingFolder, jobID);
      return;
    }
  }
}

/** Appends whatever the peer's log gained since the last offset. */
async function mirrorLog(peer: Peer, remoteJobID: string, logPath: string, offset: number): Promise<number> {
  try {
    const res = await peerJson<{ log: string; offset: number; reset: boolean }>(
      peer,
      `/api/jobs/${remoteJobID}/log?offset=${offset}`,
      {},
      30_000,
    );
    if (typeof res?.log === 'string' && res.log !== '') {
      await fs.promises.appendFile(logPath, res.log, 'utf-8');
    }
    return typeof res?.offset === 'number' ? res.offset : offset;
  } catch {
    return offset;
  }
}

/** Downloads sample images the hub has not seen yet. */
async function mirrorSamples(
  peer: Peer,
  remoteJobID: string,
  samplesFolder: string,
  have: Set<string>,
): Promise<void> {
  try {
    const res = await peerJson<{ samples: string[] }>(peer, `/api/jobs/${remoteJobID}/samples`, {}, 30_000);
    const samples = Array.isArray(res?.samples) ? res.samples : [];
    for (const remotePath of samples) {
      const name = remotePath.split(/[\\/]/).pop() as string;
      if (!name || have.has(name)) {
        continue;
      }
      await peerDownloadFile(peer, remotePath, path.join(samplesFolder, name));
      have.add(name);
    }
  } catch (e: any) {
    console.error(`Could not mirror samples from ${peer.label}:`, e?.message ?? e);
  }
}

/**
 * Brings the trained weights home once the run is over.
 *
 * A failure here is reported but does not overwrite a successful run's status:
 * the checkpoints still exist on the peer, and saying "error" would suggest the
 * training itself failed when it did not.
 */
async function mirrorCheckpoints(
  peer: Peer,
  remoteJobID: string,
  trainingFolder: string,
  jobID: string,
): Promise<void> {
  try {
    const res = await peerJson<{ files: { path: string; size: number }[] }>(
      peer,
      `/api/jobs/${remoteJobID}/files`,
      {},
      60_000,
    );
    const files = Array.isArray(res?.files) ? res.files : [];
    const weights = files.filter(f => typeof f?.path === 'string' && f.path.endsWith('.safetensors'));
    if (weights.length === 0) {
      return;
    }
    for (let i = 0; i < weights.length; i++) {
      const name = weights[i].path.split(/[\\/]/).pop() as string;
      const dest = path.join(trainingFolder, name);
      if (fs.existsSync(dest)) {
        continue;
      }
      await prisma.job
        .update({ where: { id: jobID }, data: { info: `Fetching ${name} from ${peer.label} (${i + 1}/${weights.length})…` } })
        .catch(() => {});
      await peerDownloadFile(peer, weights[i].path, dest);
    }
    await prisma.job
      .update({ where: { id: jobID }, data: { info: `Done. Weights copied from ${peer.label}.` } })
      .catch(() => {});
  } catch (e: any) {
    console.error(`Could not fetch checkpoints from ${peer.label}:`, e?.message ?? e);
    await prisma.job
      .update({
        where: { id: jobID },
        data: { info: `Training finished on ${peer.label}, but the weights could not be copied back: ${e?.message ?? e}` },
      })
      .catch(() => {});
  }
}
