'use client';

// Fork-only help registry (see FORK_NOTES.md). Merged into getDoc() so New Job
// fields without upstream docs can show CircleHelp icons when Help mode is on.
// Always-on fixes for dead upstream docKeys (adapter paths) also live here.

import React from 'react';
import { ConfigDoc } from '@/types';

const forkDocs: { [key: string]: ConfigDoc } = {
  // --- Dead upstream docKeys (always visible once registered) ---
  'config.process[0].model.assistant_lora_path': {
    title: 'Training Adapter Path',
    description: (
      <>
        Path or Huggingface repo id for the <strong>training adapter</strong> required by certain turbo models (for
        example Z-Image Turbo or Krea 2 Turbo). This adapter is fused into the model for training — it is not a normal
        &quot;resume LoRA&quot; or inference LoRA. Leave the arch default unless you know you need a different adapter
        file.
      </>
    ),
  },
  'config.process[0].model.unconditional_lora_path': {
    title: 'Unconditional Adapter Path',
    description: (
      <>
        Path or Huggingface repo id for an unconditional LoRA used during a CFG-style training pass (currently for
        Ideogram-class models). Loaded separately from your trainable LoRA so the trainer can run an unconditional
        prediction. Leave empty unless the model recipe requires it.
      </>
    ),
  },

  // --- Model ---
  'model.arch': {
    title: 'Model Architecture',
    description: (
      <>
        Selects the model family for this job. Changing architecture applies that family&apos;s defaults (learning
        settings, quantize options, sample size, etc.) and shows or hides sections that only apply to that model —
        for example Low VRAM, multistage, video frames, or a training adapter path.
      </>
    ),
  },
  'model.low_vram': {
    title: 'Low VRAM',
    description: (
      <>
        Keeps large model weights on the CPU during load and quantization so the primary GPU has more room to train.
        Training is slower than keeping everything on GPU, but it is often required on cards with less VRAM or when
        training larger models. Prefer leaving this off when you have headroom.
      </>
    ),
  },
  'model.quantize': {
    title: 'Transformer Quantization',
    description: (
      <>
        Quantizes the transformer / UNet weights to reduce VRAM. Choose a quant type (qfloat8 is the usual default) or
        None to train in full precision for that module. Lower bit depths save more memory but can hurt quality or
        stability. Some features (for example layer offloading) force float8 instead of qfloat8.
      </>
    ),
  },
  'model.quantize_te': {
    title: 'Text Encoder Quantization',
    description: (
      <>
        Quantizes the text encoder independently of the transformer. Same tradeoff as transformer quantization: lower
        precision uses less VRAM. Set to None if you have the memory and want maximum text-encoder fidelity.
      </>
    ),
  },
  'model.compile': {
    title: 'Compile Model',
    description: (
      <>
        Enables torch.compile (and related compile defaults) for the model. After a warm-up cost on the first steps,
        this can improve training throughput on supported setups. It is not compatible with every quantization or
        offloading combination — turn it off if you hit compile errors or unexpected slowdowns.
      </>
    ),
  },
  'model.layer_offloading_transformer_percent': {
    title: 'Transformer Offload %',
    description: (
      <>
        Percentage of transformer layers to keep in CPU RAM when layer offloading is enabled. Prefer as low a
        percentage as your VRAM allows for best speed; raise it only when you need the memory. See Layer Offloading
        for the overall feature notes.
      </>
    ),
  },
  'model.layer_offloading_text_encoder_percent': {
    title: 'Text Encoder Offload %',
    description: (
      <>
        Percentage of text-encoder layers to keep in CPU RAM when layer offloading is enabled. Same guidance as
        transformer offload: offload only as much as you need.
      </>
    ),
  },

  // --- Target / network ---
  'network.type': {
    title: 'Target Type',
    description: (
      <>
        The adapter type to train. <strong>LoRA</strong> is the standard low-rank adapter used by most workflows.{' '}
        <strong>LoKr</strong> uses a Kronecker-product decomposition instead of a simple low-rank pair — pick it only
        when you specifically want a LoKr network.
      </>
    ),
  },
  'network.lokr_factor': {
    title: 'LoKr Factor',
    description: (
      <>
        Decomposition factor for LoKr networks. Higher factors make a larger / more expressive network. Auto (-1) lets
        the trainer choose a factor. Only used when Target Type is LoKr.
      </>
    ),
  },
  'network.linear': {
    title: 'Linear Rank',
    description: (
      <>
        LoRA rank (and matching alpha in this UI) for linear layers. Higher rank gives more capacity to learn the
        concept, but also more VRAM, longer training, and a higher risk of overfitting — especially on small datasets.
        Common starting points are in the 8–32 range depending on the model and dataset size; the step advisor can
        suggest a recipe for your architecture.
      </>
    ),
  },
  'network.conv': {
    title: 'Conv Rank',
    description: (
      <>
        LoRA rank for convolutional layers (and matching alpha). Mostly relevant for older UNet architectures (for
        example SD1.5 / SDXL). Many modern transformer models hide this field because they have no conv targets.
      </>
    ),
  },

  // --- Slider (concept slider job type) ---
  'slider.target_class': {
    title: 'Target Class',
    description: (
      <>
        The neutral class being edited by the concept slider (for example &quot;person&quot; or &quot;car&quot;). This
        is the baseline the positive and negative prompts pull away from.
      </>
    ),
  },
  'slider.positive_prompt': {
    title: 'Positive Prompt',
    description: (
      <>
        The positive pole of the slider concept (for example &quot;person who is happy&quot;). Training learns the
        direction from the negative prompt toward this prompt.
      </>
    ),
  },
  'slider.negative_prompt': {
    title: 'Negative Prompt',
    description: (
      <>
        The negative pole of the slider concept (for example &quot;person who is sad&quot;). Paired with the positive
        prompt to define the slider axis.
      </>
    ),
  },
  'slider.anchor_class': {
    title: 'Anchor Class',
    description: (
      <>
        Optional anchor class used to reduce drift away from the base concept while the slider trains. Leave blank if
        you do not need an anchor.
      </>
    ),
  },

  // --- Save ---
  'save.dtype': {
    title: 'Data Type',
    description: (
      <>
        Floating-point type used when writing checkpoints. BF16 is the usual modern default (good quality / size
        balance). FP16 is widely compatible. FP32 is largest and rarely needed for LoRA saves.
      </>
    ),
  },
  'save.save_every': {
    title: 'Save Every',
    description: (
      <>
        Write a step checkpoint every N optimizer steps. Smaller values give more restore points and more sample
        history at the cost of disk space and a little training overhead.
      </>
    ),
  },
  'save.max_step_saves_to_keep': {
    title: 'Max Step Saves to Keep',
    description: (
      <>
        How many rolling step checkpoints to retain. When a new save would exceed this count, the oldest step save is
        deleted. The final output is separate from these rolling saves.
      </>
    ),
  },

  // --- Training ---
  'train.batch_size': {
    title: 'Batch Size',
    description: (
      <>
        Number of images (or items) in each forward pass. Effective batch size is roughly{' '}
        <code>batch_size × gradient_accumulation</code>. Larger batches need more VRAM; raise gradient accumulation
        instead when you want a larger effective batch on a small card.
      </>
    ),
  },
  'train.gradient_accumulation': {
    title: 'Gradient Accumulation',
    description: (
      <>
        Number of micro-batches to accumulate before taking one optimizer step. This increases effective batch size
        without increasing per-step VRAM the way a larger batch size would. A step in the UI / step counter advances
        once per optimizer update, not once per micro-batch.
      </>
    ),
  },
  'train.steps': {
    title: 'Steps',
    description: (
      <>
        Total optimizer steps for the run. How many you need depends on dataset size, repeats, rank, and learning
        rate. Use the step suggestion under this card (when a dataset is selected) for a starting range based on your
        architecture and image count.
      </>
    ),
  },
  'train.optimizer': {
    title: 'Optimizer',
    description: (
      <>
        Optimization algorithm used to update LoRA weights. AdamW is a common default. 8-bit variants reduce optimizer
        state VRAM. Adafactor adapts learning rates with less tuning. Prodigy / Automagic families auto-tune learning
        rate — when Automagic is selected, the hint under this field covers the extra settings it uses.
      </>
    ),
  },
  'train.lr': {
    title: 'Learning Rate',
    description: (
      <>
        Step size for the optimizer. Too high tends to produce unstable loss or overfitting; too low undertrains.
        Good LoRA ranges are architecture-specific (often around 1e-4 for many modern models, lower for some recipes).
        The step advisor can apply a researched starting LR for your arch and dataset size.
      </>
    ),
  },
  'train.optimizer_params.weight_decay': {
    title: 'Weight Decay',
    description: (
      <>
        Regularization applied to weights (AdamW-style decoupled decay for most optimizers here). Small values such as
        0.0001 are common. Higher decay can reduce overfitting but may also weaken the learned concept.
      </>
    ),
  },
  'train.timestep_type': {
    title: 'Timestep Type',
    description: (
      <>
        How noise levels (timesteps) are sampled during training for flow-matching / similar schedulers:
        <br />
        <br />
        <strong>Sigmoid</strong> — sigmoid-distributed timesteps (common default).
        <br />
        <strong>Linear</strong> — uniform / linear spacing.
        <br />
        <strong>Shift</strong> — shifted schedule used by some model recipes.
        <br />
        <strong>Weighted</strong> — applies a weighting scheme over timesteps.
        <br />
        <br />
        Many architectures set a preferred default when you pick them. This field is hidden for classic SDXL / SD1.5
        UNet training.
      </>
    ),
  },
  'train.content_or_style': {
    title: 'Timestep Bias',
    description: (
      <>
        Biases which denoising timesteps are trained more often (cubic sampling from the DreamBooth paper):
        <br />
        <br />
        <strong>Balanced</strong> — sample timesteps uniformly in the allowed range.
        <br />
        <strong>High Noise</strong> (content) — favor earlier / noisier timesteps; better for structure and layout.
        <br />
        <strong>Low Noise</strong> (style) — favor later / cleaner timesteps; better for fine detail and style.
      </>
    ),
  },
  'train.loss_type': {
    title: 'Loss Type',
    description: (
      <>
        How prediction error is measured:
        <br />
        <br />
        <strong>Mean Squared Error</strong> — standard default for most LoRA training.
        <br />
        <strong>Mean Absolute Error</strong> — L1 loss; sometimes more robust to outliers.
        <br />
        <strong>Wavelet</strong> — frequency-aware loss that can emphasize detail.
        <br />
        <strong>Stepped Recovery</strong> — stepped recovery loss variant used by some recipes.
        <br />
        <br />
        Stick with MSE unless a guide for your model says otherwise.
      </>
    ),
  },
  'train.ema_config.use_ema': {
    title: 'Use EMA',
    description: (
      <>
        Maintains an exponential moving average of the trainable weights alongside the live weights. EMA weights are
        often smoother for sampling and final checkpoints. Slightly more VRAM / bookkeeping; leave off unless you want
        that stability.
      </>
    ),
  },
  'train.ema_config.ema_decay': {
    title: 'EMA Decay',
    description: (
      <>
        Smoothing factor for the EMA weights. Values near 0.99–0.999 are typical. Higher decay means the average moves
        more slowly (more history, less noise); lower decay tracks the live weights more quickly.
      </>
    ),
  },
  'train.diff_output_preservation_multiplier': {
    title: 'DOP Loss Multiplier',
    description: (
      <>
        Strength of the Differential Output Preservation loss relative to the main training loss. Raise it to preserve
        the class more aggressively; lower it if DOP is fighting the concept you want to learn. See Differential Output
        Preservation for how DOP works.
      </>
    ),
  },
  'train.diff_output_preservation_class': {
    title: 'DOP Preservation Class',
    description: (
      <>
        Class token used when the trigger word is stripped for the DOP prior pass. Example: trigger &quot;Alice&quot;,
        class &quot;woman&quot; so the prior prompt becomes the same caption with &quot;woman&quot; instead of
        &quot;Alice&quot;. Required for DOP to know what to preserve.
      </>
    ),
  },
  'train.blank_prompt_preservation_multiplier': {
    title: 'BPP Loss Multiplier',
    description: (
      <>
        Strength of the Blank Prompt Preservation loss relative to the main loss. Higher values push harder to keep the
        model&apos;s blank-prompt behavior intact.
      </>
    ),
  },
  'train.differential_guidance_scale': {
    title: 'Differential Guidance Scale',
    description: (
      <>
        Scale applied when Differential Guidance is enabled. Higher values strengthen the guidance effect during
        training. See Do Differential Guidance for what the feature does.
      </>
    ),
  },

  // --- Validation ---
  'train.validation_config.validate_every_n_steps': {
    title: 'Validate Every',
    description: (
      <>
        Run the fixed validation loss check every N optimizer steps. Validation uses held-out images encoded once at
        startup and predicted at fixed sigmas/seeds so the logged val/loss is comparable across the run.
      </>
    ),
  },
  'train.validation_config.resolution': {
    title: 'Validation Resolution',
    description: (
      <>
        Resolution used when encoding and predicting validation images. Does not have to match every training bucket,
        but should be reasonable for the model (for example 512 or 1024).
      </>
    ),
  },
  'train.validation_config.validation_sigmas': {
    title: 'Validation Sigmas',
    description: (
      <>
        Noise levels (sigmas) at which each validation image is predicted. More sigmas give a broader check at a small
        extra cost. The average loss across items and sigmas is logged as val/loss.
      </>
    ),
  },
  'train.validation_config.validation_items.prompt': {
    title: 'Validation Prompt',
    description: (
      <>
        Prompt paired with this held-out validation image. Use a prompt that matches the concept you are training.
        Validation images must <strong>not</strong> be part of the training dataset.
      </>
    ),
  },

  // --- Datasets ---
  'datasets.folder_path': {
    title: 'Target Dataset',
    description: (
      <>
        Folder of training images (and matching caption files). Pick a top-level dataset from the list, or use Browse
        subfolders to point at a nested folder under that dataset root.
      </>
    ),
  },
  'datasets.network_weight': {
    title: 'LoRA Weight',
    description: (
      <>
        Per-dataset multiplier on this dataset&apos;s loss contribution. Use values other than 1.0 when balancing
        multiple datasets (for example down-weighting a large regularization set).
      </>
    ),
  },
  'datasets.default_caption': {
    title: 'Default Caption',
    description: (
      <>
        Caption used when an image has no caption file. If empty and there is no caption file, behavior depends on
        other settings (for example trigger word alone). Prefer real per-image captions when you can.
      </>
    ),
  },
  'datasets.caption_dropout_rate': {
    title: 'Caption Dropout Rate',
    description: (
      <>
        Probability (0–1) of dropping the caption for a sample during training, which trains the model with an empty /
        unconditional-style prompt on those steps. Helps reduce caption over-reliance. Does not work with Cache Text
        Embeddings (that path cannot change prompts dynamically).
      </>
    ),
  },
  'datasets.caption_ext': {
    title: 'Caption Extension',
    description: (
      <>
        File extension for caption files next to each image (for example <code>txt</code>, <code>json</code>, or{' '}
        <code>caption</code>). The trainer looks for <code>imageName.ext</code> beside each image.
      </>
    ),
  },
  'datasets.cache_latents_to_disk': {
    title: 'Cache Latents',
    description: (
      <>
        Encode images with the VAE once and cache latents to disk for later epochs. Speeds up training after the first
        pass and uses more disk. Incompatible with some augmentations (caching will be disabled if those are enabled).
      </>
    ),
  },
  'datasets.is_reg': {
    title: 'Is Regularization',
    description: (
      <>
        Marks this dataset as a regularization / prior-preservation set rather than the main concept set. Regularization
        images help the model keep broader class knowledge while you train a specific subject or style.
      </>
    ),
  },
  'datasets.resolution': {
    title: 'Resolutions',
    description: (
      <>
        Aspect-ratio bucket resolutions this dataset may train at. The trainer picks a matching bucket per image. Enable
        the sizes you care about; more buckets need more cached latents / VRAM variety. Match sizes your base model
        handles well (often 512–1024 for many image models).
      </>
    ),
  },

  // --- Sample ---
  'sample.sample_every': {
    title: 'Sample Every',
    description: (
      <>
        Generate preview samples every N optimizer steps. Lower values give more frequent visual feedback but slow
        training and use more disk for sample images.
      </>
    ),
  },
  'sample.sample_start_step': {
    title: 'Sample Start Step',
    description: (
      <>
        First optimizer step at which periodic sampling is allowed. Use this to skip early noisy previews until training
        has started to converge. Separate from Skip / Force First Sample.
      </>
    ),
  },
  'sample.sampler': {
    title: 'Sampler',
    description: (
      <>
        Denoising sampler used when generating preview samples. FlowMatch is correct for most modern flow / flux-style
        models; DDPM is for classic diffusion UNet stacks. Match the sampler family to your architecture.
      </>
    ),
  },
  'sample.guidance_scale': {
    title: 'Guidance Scale',
    description: (
      <>
        Classifier-free guidance strength for preview samples. Higher values follow the prompt more strongly (and can
        oversaturate); lower values are closer to the raw model. Many flow models train/sample near 1.0 — use what your
        model&apos;s inference recipe recommends.
      </>
    ),
  },
  'sample.sample_steps': {
    title: 'Sample Steps',
    description: (
      <>
        Number of denoising steps used for each preview sample. More steps usually look cleaner but take longer. Turbo /
        few-step models often need only a handful of steps.
      </>
    ),
  },
  'sample.width': {
    title: 'Sample Width',
    description: (
      <>
        Default width in pixels for preview samples. Per-prompt Width fields can override this for individual samples.
      </>
    ),
  },
  'sample.height': {
    title: 'Sample Height',
    description: (
      <>
        Default height in pixels for preview samples. Per-prompt Height fields can override this for individual samples.
      </>
    ),
  },
  'sample.num_frames': {
    title: 'Sample Num Frames',
    description: (
      <>
        Number of frames to generate for video preview samples. Match your model&apos;s expected frame count / length
        (for example Wan recipes often use specific frame counts at 16 fps).
      </>
    ),
  },
  'sample.fps': {
    title: 'Sample FPS',
    description: (
      <>
        Frames per second used when saving / playing video preview samples. Should match the frame rate your video model
        expects (often 16 for Wan-class models).
      </>
    ),
  },
  'sample.seed': {
    title: 'Seed',
    description: (
      <>
        Base random seed for preview samples. With Walk Seed enabled, each prompt in the list increments from this seed
        so you get a stable sequence of different seeds.
      </>
    ),
  },
  'sample.walk_seed': {
    title: 'Walk Seed',
    description: (
      <>
        When enabled, each sample prompt uses <code>seed + promptIndex</code> instead of the same seed for every prompt.
        Useful for comparing several prompts without them all sharing one RNG stream.
      </>
    ),
  },
  'train.skip_first_sample': {
    title: 'Skip First Sample',
    description: (
      <>
        Skip the sample that would run when the trainer starts. Saves a little time at launch. Cannot be combined with
        Force First Sample.
      </>
    ),
  },
  'train.disable_sampling': {
    title: 'Disable Sampling',
    description: (
      <>
        Turns off all preview sampling for the run (including first sample and periodic samples). Use this for pure
        throughput benchmarks or when you do not need previews. Cannot be combined with Force First Sample.
      </>
    ),
  },
  'sample.samples.prompt': {
    title: 'Sample Prompt',
    description: (
      <>
        Prompt used for this preview sample. Include your trigger word (or the <code>[trigger]</code> placeholder) if
        the concept needs it — trigger words are not auto-added to sample prompts. Leave per-sample Width / Height /
        Seed / LoRA Scale blank to inherit the defaults above.
      </>
    ),
  },
  'sample.samples.width': {
    title: 'Per-Sample Width',
    description: (
      <>
        Optional width override for this sample only. Leave blank to use the Sample card&apos;s default Width.
      </>
    ),
  },
  'sample.samples.height': {
    title: 'Per-Sample Height',
    description: (
      <>
        Optional height override for this sample only. Leave blank to use the Sample card&apos;s default Height.
      </>
    ),
  },
  'sample.samples.seed': {
    title: 'Per-Sample Seed',
    description: (
      <>
        Optional seed override for this sample only. Leave blank to use the Sample card seed (or walked seed when Walk
        Seed is on).
      </>
    ),
  },
  'sample.samples.network_multiplier': {
    title: 'LoRA Scale',
    description: (
      <>
        Strength multiplier for the LoRA when generating this preview (1.0 = full trained strength). Useful for checking
        how the concept looks at lower or higher weights. Leave blank for 1.0.
      </>
    ),
  },
};

export default forkDocs;
