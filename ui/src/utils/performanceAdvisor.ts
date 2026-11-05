// Fork-only, advisory profiles. No throughput or memory-fit claims without measurements.
import type { GpuInfo, JobConfig } from '../types';

export type PerformanceChange = { path: string; value: boolean };
export type PerformanceRow = {
  id: string;
  label: string;
  status: 'Enabled' | 'Candidate' | 'Untested' | 'Review';
  detail: string;
  changes: PerformanceChange[];
};
export type PerformancePlan = {
  model: 'Anima' | 'Krea 2';
  gpu: GpuInfo | null;
  freeMiB: number | null;
  context: string;
  notice: string;
  rows: PerformanceRow[];
};

export function selectedLocalGpu(gpuIDs: string | null, gpus: GpuInfo[]): GpuInfo | null {
  if (!gpuIDs || !/^\d+$/.test(gpuIDs.trim())) return null;
  return gpus.find(gpu => gpu.index === Number(gpuIDs.trim())) ?? null;
}

export function performancePlan(job: JobConfig, gpuIDs: string | null, gpus: GpuInfo[]): PerformancePlan | null {
  const process = job.config.process[0];
  if (!process) return null;
  const { model, train, network } = process;
  const arch = model.arch.split(':')[0];
  if (!['anima', 'krea2'].includes(arch) || process.type !== 'diffusion_trainer' ||
      !network || !['lora', 'lokr'].includes(network.type)) return null;
  const datasets = (process.datasets || []) as (typeof process.datasets[number] & {
    cache_latents?: boolean;
    cache_text_embeddings?: boolean;
    augments?: unknown[];
    augmentations?: unknown[];
    random_crop?: boolean;
    random_scale?: boolean;
    token_dropout_rate?: number;
    control_from_same_folder?: boolean;
  })[];
  // Edit/slider conditioning has separate cache semantics and remains out of scope.
  if (model.model_kwargs?.edit || model.arch.includes(':o_edit') || datasets.some(d =>
      d.num_frames > 1 || d.do_audio || d.do_i2v || d.control_from_same_folder ||
      [d.control_path, d.control_path_1, d.control_path_2, d.control_path_3, ...(d.controls || [])].some(Boolean))) return null;

  const gpu = selectedLocalGpu(gpuIDs, gpus);
  if (gpu && (!/\bRTX\s*5090\b/i.test(gpu.name) || /laptop/i.test(gpu.name))) return null;
  const freeMiB = gpu && Number.isFinite(gpu.memory.free) && gpu.memory.free >= 0 &&
    Number.isFinite(gpu.memory.total) && gpu.memory.total > 0 && gpu.memory.free <= gpu.memory.total
    ? gpu.memory.free : null;
  const resolutions = [...new Set(datasets.flatMap(d => d.resolution || []))]
    .filter(r => Number.isFinite(r) && r > 0).sort((a, b) => a - b);
  const batches = [...new Set(datasets.map(d => d.batch_size || train.batch_size))].sort((a, b) => a - b);
  const plan: PerformancePlan = {
    model: arch === 'anima' ? 'Anima' : 'Krea 2', gpu, freeMiB,
    context: `Rank ${network.linear} · batch ${batches.join('/') || train.batch_size} · resolution ${resolutions.join('/') || 'unset'} · ${train.steps} steps`,
    notice: '', rows: [],
  };
  if (!gpu || freeMiB === null) {
    plan.notice = 'Select one local RTX 5090 with live memory data.';
    return plan;
  }
  if (train.optimizer.toLowerCase() !== 'automagic4') {
    plan.notice = 'Select Automagic v4 to use this profile. The advisor does not change your optimizer.';
    return plan;
  }
  const legacyAccum = (train as typeof train & { gradient_accumulation_steps?: number }).gradient_accumulation_steps ?? 1;
  if ((train.gradient_accumulation ?? 1) !== 1 || legacyAccum !== 1) {
    plan.notice = 'This 5090 profile uses accumulation 1. Adjust the batch and exposure plan before you change accumulation.';
    return plan;
  }
  if (!datasets.length) {
    plan.notice = 'Select a dataset to review cache settings.';
    return plan;
  }
  plan.notice = 'This advisor has no GPU measurements. Free memory does not prove that a job fits.';
  const prefix = 'config.process[0]';
  const latentBlocked = datasets.some(d => d.augments?.length || d.augmentations?.length || d.random_crop || d.random_scale);
  const latentEnabled = datasets.every(d => d.cache_latents && d.cache_latents_to_disk);
  plan.rows.push({
    id: 'latents', label: 'Latent Cache',
    status: latentBlocked ? 'Review' : latentEnabled ? 'Enabled' : 'Candidate',
    detail: latentBlocked ? 'Image augmentation or random crops need a separate cache review.' :
      'Keep latents on disk and in system RAM. The first cache pass takes time.',
    changes: latentBlocked ? [] : datasets.flatMap((d, i) =>
      (['cache_latents', 'cache_latents_to_disk'] as const).filter(key => !d[key])
        .map(key => ({ path: `${prefix}.datasets[${i}].${key}`, value: true }))),
  });
  const textBlocked = train.train_text_encoder || datasets.some(d => d.shuffle_tokens || (d.token_dropout_rate ?? 0) > 0);
  const textEnabled = train.cache_text_embeddings || datasets.every(d => d.cache_text_embeddings);
  plan.rows.push({
    id: 'text', label: 'Text Cache',
    status: textBlocked ? 'Review' : textEnabled ? 'Enabled' : 'Candidate',
    detail: textBlocked ? 'Text encoder training or token changes need a separate cache review.' :
      'Cache caption embeddings so the trainer can unload the text encoder. Caption dropout remains available.',
    changes: textBlocked || textEnabled ? [] : [{ path: `${prefix}.train.cache_text_embeddings`, value: true }],
  });
  plan.rows.push({
    id: 'compile', label: 'Block Compile', status: model.layer_offloading ? 'Review' : 'Untested',
    detail: model.layer_offloading ? 'Check compile compatibility with layer offloading before a trial.' :
      model.compile ? 'Compilation is enabled. Speed, warm-up cost and memory use remain unverified with Automagic v4.' :
      'Test block compilation on a longer run. Check Torch/Triton compatibility before the trial.',
    changes: [],
  });
  plan.rows.push({
    id: 'checkpoint', label: 'Checkpointing', status: 'Untested',
    detail: train.gradient_checkpointing === false ? 'Checkpointing is off. Measure training and preview memory before you retain this setting.' :
      arch === 'anima' ? 'Test without checkpointing after you measure training and preview memory.' :
      'Keep checkpointing until a measured Krea 2 run proves that the alternative fits.',
    changes: [],
  });
  plan.rows.push({
    id: 'memory', label: 'Precision And Offload', status: 'Untested',
    detail: arch === 'anima' ? 'Test BF16 without offloading first. Preserve the current precision until you compare results.' :
      'Compare BF16 and supported quantized paths. Use measured memory to select the offload fraction.',
    changes: [],
  });
  return plan;
}
