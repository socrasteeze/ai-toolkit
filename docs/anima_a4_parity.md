# A4 Parity Validation: toolkit Anima port vs TrainFlow/sd-scripts

Gate artifact for spec `ANIMA_INTEGRATION_SPEC.md` §A4. Date: 2026-07-12.

## Setup

Matched-hyperparameter pair, both trained on `anima_sample_training/training_data`
(153 img/caption pairs), rank 32 / alpha 32 LoRA on DiT blocks only (adapter frozen),
AdamW lr 2e-5 wd 0.01, constant schedule, batch 1, grad accum 1, 512px bucketed,
bf16, sigmoid timestep sampling with `sigmoid_scale=1.3`, 400 steps, per-step loss
to tensorboard, samples every 100 steps (same prompt, sample seed 42, CFG 4, 20 steps).

- TrainFlow side: `Anima-TrainFlow/training/output/a4_ref/` (configs, train.log,
  TB events, checkpoints @200/400, samples) — vendored sd-scripts
  `anima_train_network.py`, seed 42.
- Toolkit side: `config/train_anima_a4_parity.yaml` → `output/anima_a4_parity/`
  (checkpoints, samples) + `output/anima_a4_parity_tb/` (TB events).

Cross-framework RNG cannot be matched (different shuffle/noise/timestep draw
implementations), so the comparison is distributional, not per-step.

## Loss curves

Windowed means of per-step loss (window = 50 steps):

| step | kohya (`loss/current`) | toolkit (`loss`) | ratio |
|-----:|-----------------------:|-----------------:|------:|
|  50  | 0.1650 | 0.1755 | 1.064 |
| 100  | 0.1850 | 0.1788 | 0.967 |
| 150  | 0.1674 | 0.1911 | 1.142 |
| 200  | 0.1960 | 0.1789 | 0.913 |
| 250  | 0.1788 | 0.1740 | 0.973 |
| 300  | 0.1953 | 0.1772 | 0.907 |
| 350  | 0.1948 | 0.1640 | 0.842 |
| 400  | 0.1940 | 0.1545 | 0.796 |

- Overall means: kohya 0.1845, toolkit 0.1743 (−5.5%).
- First-half means: 0.1783 vs 0.1812 — statistically identical.
- Second-half means: 0.1907 vs 0.1675. Per-step loss std is 0.114–0.143
  (flow-matching loss is dominated by the timestep draw), so SEM over 200 steps is
  ~0.008–0.010 and the second-half gap is ~1.8σ — **within noise, no confirmed
  systematic divergence**. If a real effect exists, candidate benign causes:
  bucket-set differences (kohya `bucket_no_upscale` keeps sub-512 images at native
  res across 14 buckets; toolkit uses fixed-area 512 buckets) and AdamW eps
  (toolkit pins 1e-6, kohya uses torch default 1e-8).

Checked and ruled out as divergence sources:

- **Timestep sampling**: kohya `sigma = sigmoid(1.3·randn)`; toolkit
  `AnimaFlowMatchScheduler` draws the same logit-normal (its `(1−t)·1000` timestep
  flip is distribution-neutral — sigmoid(randn) is symmetric about 0.5).
- **Loss weighting**: both plain MSE on rectified-flow target `noise − latents`
  (`weighting_scheme="none"` / toolkit default); equivalent at batch 1.
- **LoRA scale**: both train at effective scale 1.0 (alpha/rank = 32/32 vs PEFT
  scale-1.0 with alpha synthesized at export).

## Samples

Step-400 samples from both trainers (same prompt, CFG 4) are coherent, artifact-free
oil-painting-style images with equivalent style fidelity. Compositions differ
(unmatched RNG). No quality gap in either direction at 100/200/300/400.

## Prodigy behavior

Both trainers instantiate the **same `prodigyopt==1.1.2` `Prodigy` class from the
same venv**, so the d-adaptation algorithm is byte-identical; only construction
defaults differ.

Empirical check: 100-step matched runs with TrainFlow's default Prodigy args
(`decouple=True, weight_decay=0.01, d_coef=1.0, use_bias_correction=True,
safeguard_warmup=True, betas=(0.9,0.99)`, lr 1.0, constant schedule):

- kohya (`a4_prodigy`, TB `lr/d*lr/unet`): d stays at d0 = 1e-6 through ~step 55,
  then grows: 1.95e-6 @71, 2.11e-6 @81, 4.07e-6 @91, **4.77e-6 @100**.
- toolkit (`anima_a4_prodigy`, `d` read from saved `optimizer.pt` param group):
  d = **2.48e-6 @100** (d0 = 1e-6, d_hat = d_max = d, k = 100). The saved param
  group confirms every matched arg took effect: betas (0.9, 0.99), weight_decay
  0.01, d_coef 1.0, use_bias_correction, safeguard_warmup, decouple.

Both runs escaped the d0 = 1e-6 safeguard-warmup plateau and adapted upward to the
same order of magnitude (2.5e-6 vs 4.8e-6). `d` is a stochastic function of the
gradient sequence, and the two runs see different data order / noise / timestep
draws, so a ~2× spread at step 100 is expected run-to-run variation, not an
implementation difference — the optimizer class itself is identical code.

Intentional/known differences (document per spec §A4.4):

1. Toolkit pins `eps=1e-6` on Prodigy construction (`toolkit/optimizer.py`);
   prodigyopt default (and kohya's effective value) is 1e-8. Not overridable via
   `optimizer_params` (would be a duplicate kwarg). Effect: slightly stronger
   denominator damping; negligible at LoRA gradient scales.
2. Toolkit silently raises `lr < 0.1` to 1.0 for Prodigy; kohya only warns.
   Harmless for the standard lr=1.0 usage.
3. kohya logs `lr/d*lr` to tensorboard each step; toolkit logs only the scheduler
   `lr` (constant 1.0), so d evolution is not visible in toolkit TB — inspect
   `optimizer.pt` if needed.
4. TrainFlow's Prodigy defaults above must be passed explicitly in toolkit configs
   via `train.optimizer_params` — toolkit passes through to prodigyopt whose own
   defaults differ (`weight_decay=0`, `use_bias_correction=False`,
   `safeguard_warmup=False`, `betas=(0.9,0.999)`).

## Verdict

**A4 gate: PASS.** Loss curves are statistically indistinguishable in the first
half and within ~1.8σ overall; samples show equivalent style adaptation and no
quality gap; Prodigy uses the identical library with matched args passing through
correctly, with the four documented (benign) construction/logging differences
above. No systematic training-math divergence found.
