import { JobConfig } from '@/types';
import { objectCopy } from '@/utils/basic';
import { defaultJobConfig, defaultDatasetConfig, migrateJobConfig } from '@/app/jobs/new/jobConfig';

// Fork-only file (see FORK_NOTES.md). A preset is a JobConfig stored as a file in the
// presets folder. Saving strips machine-specific values so presets are shareable; loading
// fills gaps from the defaults and preserves the current form's local values.

const PLACEHOLDER_DATASET_PATH = defaultDatasetConfig.folder_path;

// Deep-merge source over target. Arrays are replaced wholesale (datasets, samples, etc.
// are recipes, not lists to be unioned).
const deepMerge = (target: any, source: any): any => {
  if (Array.isArray(source)) return objectCopy(source);
  if (source === null || typeof source !== 'object') return source;
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    return objectCopy(source);
  }
  const result: any = { ...target };
  for (const key of Object.keys(source)) {
    result[key] = deepMerge(target[key], source[key]);
  }
  return result;
};

// Prepare the current form config for saving as a shareable preset: keep the full training
// recipe, but reset anything tied to this machine or this specific job.
export const configToPreset = (jobConfig: JobConfig): JobConfig => {
  const preset = objectCopy(jobConfig) as any;
  preset.config.name = 'preset';
  const process = preset.config.process[0];
  process.training_folder = 'output';
  process.device = 'cuda';
  delete process.sqlite_db_path;
  if (Array.isArray(process.datasets)) {
    for (const dataset of process.datasets) {
      dataset.folder_path = PLACEHOLDER_DATASET_PATH;
    }
  }
  return preset as JobConfig;
};

// Apply a loaded preset over the current form state. The preset may be a UI export, a
// CLI-style YAML from config/examples, or another user's config — missing fields are
// filled from the defaults so the simple form never hits undefined values, and the
// current form's local values (job name, dataset paths, runtime fields) are preserved.
export const applyPreset = (preset: any, currentConfig: JobConfig, trainingFolder?: string): JobConfig => {
  if (!preset?.config?.process?.[0]) {
    throw new Error('Config is missing config.process[0]');
  }

  const merged = deepMerge(objectCopy(defaultJobConfig), preset) as any;
  const process = merged.config.process[0];

  // fill missing per-dataset fields from the default dataset config
  if (Array.isArray(process.datasets)) {
    process.datasets = process.datasets.map((d: any) => deepMerge(objectCopy(defaultDatasetConfig), d));
  } else {
    process.datasets = [objectCopy(defaultDatasetConfig)];
  }

  // the CLI trainer type has no UI form; the modern equivalent does
  if (process.type === 'sd_trainer') {
    process.type = 'diffusion_trainer';
  }

  // preserve this machine's / this job's values (same fields the Import Config flow sets)
  merged.config.name = currentConfig.config.name;
  process.training_folder = trainingFolder || currentConfig.config.process[0].training_folder;
  process.sqlite_db_path = './aitk_db.db';
  process.device = 'cuda';
  process.performance_log_every = 10;

  const currentPaths = currentConfig.config.process[0].datasets
    .map(d => d.folder_path)
    .filter(p => p && p !== PLACEHOLDER_DATASET_PATH);
  process.datasets.forEach((dataset: any, i: number) => {
    if (currentPaths.length > 0) {
      dataset.folder_path = currentPaths[Math.min(i, currentPaths.length - 1)];
    }
  });

  return migrateJobConfig(merged as JobConfig);
};
