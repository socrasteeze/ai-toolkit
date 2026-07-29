# Training profiles: `performance` vs `background` vs `laptop16gb`

Every architecture preset in `presets/` ships in two profiles (spec
`ANIMA_INTEGRATION_SPEC.md` Workstream C), plus a third tier added 2026-07-28 for
a 16 GB laptop GPU. Hardware tuning lives only in these preset files — never in
model classes.

**Both original profiles assume the 32 GB desktop RTX 5090.** On a 16 GB card the
two-profile framing collapses: `background` becomes the *performance* option and
`performance`/`5090_fast` are simply out of reach. That is what the third tier is for.

## `performance`

Tuned for the full RTX 5090: bf16, no quantization (Anima 2B / Klein 4B / SDXL),
batch size sized to use most of the 32 GB. Use when the machine is dedicated to
the run.

## `background` (default for Anima/SDXL)

Deliberately leaves headroom for concurrent desktop use: batch 1 with gradient
accumulation 2 (same effective batch as `performance`), latent + text-embed
caching on, `low_vram` so idle components park on CPU. Expect roughly 2–3× the
wall-clock of `performance`.

Switching mid-project is safe: profiles only change batch/accumulation/caching/
placement, not the training math — resume from the latest checkpoint with the
other preset if you need the machine back (or a faster finish).

## Measured VRAM — Anima 2B `background` (gate C, 2026-07-12)

Live 120-step run of `presets/anima_lora_background.json` settings
(res [512, 768, 1024] buckets, batch 1 + accum 4, caching on, low_vram,
*measured before the 2026-07-29 effective-batch reduction — the preset now ships
accum 2, which only lowers these figures*,
1024×1024/30-step preview sampling) on the 5090, sampled every 2 s via
nvidia-smi (total GPU memory, including the ~2.6 GB desktop baseline):

| phase | VRAM | % of 32 GB |
|---|---|---|
| steady-state training (median) | 9.9 GB | 30% |
| steady-state training (p95) | 10.7 GB | 33% |
| peak (1024×1024 sample generation) | 14.1 GB | 43% |

**Target ≤60–70% (19.6–22.9 GB): PASS** — worst case leaves ~18 GB free for
desktop use. Wall-clock: ~2.6 s per accumulated step (120 steps in 5:07,
caches warm).

## `laptop16gb` (added 2026-07-28)

Second machine: RTX 5080 Laptop (16 GB, ~15.9 GB usable), Core Ultra 9 275HX,
96 GB system RAM, native Windows. Presets: `anima_lora_laptop16gb`,
`flux_lora_laptop16gb`, `sdxl_character_lora_laptop16gb`,
`illustriousxl_character_lora_laptop16gb`, `krea2_lora_laptop16gb`
(added 2026-07-29; parent is `krea2_lora_16gb`, which already targeted 16 GB —
the laptop variant adds RAM-served latents, 768 preview sampling and the
sqlite poll throttle, and changes no recipe value).

**Every recipe value is inherited unchanged from the parent preset.** These files
change only how a run fits in memory and how it feeds the GPU, so checkpoints stay
interchangeable with the desktop profiles. The four levers:

1. **`cache_latents: true` alongside `cache_latents_to_disk: true`** — latents are
   written once and then served from RAM. Disk-only caching re-reads *and deep-copies*
   every latent from disk on every fetch, every step (`toolkit/dataloader_mixins.py
   get_latent`). This matters more here than on the desktop because `num_workers` is
   hardcoded to 0 on native Windows (`toolkit/data_loader.py`), so every disk read is
   serialized with GPU compute. The 96 GB pool is what makes a resident cache free.
2. **`low_vram: true`** — parks idle components on CPU. Generic to all archs
   (`toolkit/stable_diffusion_model.py:199`), not just the low-VRAM-first ones.
   `flux_lora_24gb` leaves it unset, which is the single biggest gap for this card.
3. **Preview sampling at 768** (flux/anima) — on the gate-C run above, the *peak* was
   sample generation (14.1 GB), not the training loop (9.9–10.7 GB). Sampling is the
   binding constraint on 16 GB. SDXL-family presets keep 1024 sampling: it is their
   native resolution and cheap relative to the flux-family models.
4. **Batch discipline on SDXL/Illustrious** — batch 1 + `gradient_accumulation: 2`,
   trading wall-clock for VRAM. As of 2026-07-29 the advisor also recommends **batch 2**
   for vanilla SDXL/SD1.5/Illustrious/Pony (`ui/src/utils/stepSuggestion.ts`), so preset
   and advisor now agree on effective batch; the advisor still has no VRAM awareness at
   all, so on this machine reach that effective batch through accumulation rather than
   batch size. Its rank/alpha/LR/scheduler buttons are hardware-independent and safe.
   The drop from effective batch 4 to 2 was an overfitting fix, not a VRAM one — see
   PLAN.md's 2026-07-29 entry: the step suggestion divides by effective batch, and at 4
   the quotient falls under the arch step floor on small/medium datasets and is clamped
   back up, inflating real per-image exposure 2–3× past target.

**Status: NOT MEASURED.** No run has been made on the 16 GB machine — every number
above is either a 32 GB measurement or an inference from config values. The gate-C
figures suggest Anima has roughly 4 GB of headroom here, and that FLUX.1-dev (12B
params, fp8) is the genuinely risky one. Documented OOM fallback order, in each
preset's `meta.description`: drop training resolution first, then `layer_offloading`
(see `krea2_lora_16gb` for the pattern; note it silently rewrites `qfloat8` →
`float8`, `toolkit/config_modules.py:721`), and change batch/accum last since that
changes the recipe rather than the profile.
