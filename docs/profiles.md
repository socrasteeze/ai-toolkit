# Training profiles: `performance` vs `background`

Every architecture preset in `presets/` ships in two profiles (spec
`ANIMA_INTEGRATION_SPEC.md` Workstream C). Hardware tuning lives only in these
preset files — never in model classes.

## `performance`

Tuned for the full RTX 5090: bf16, no quantization (Anima 2B / Klein 4B / SDXL),
batch size sized to use most of the 32 GB. Use when the machine is dedicated to
the run.

## `background` (default for Anima/SDXL)

Deliberately leaves headroom for concurrent desktop use: batch 1 with gradient
accumulation 4 (same effective batch as `performance`), latent + text-embed
caching on, `low_vram` so idle components park on CPU. Expect roughly 2–3× the
wall-clock of `performance`.

Switching mid-project is safe: profiles only change batch/accumulation/caching/
placement, not the training math — resume from the latest checkpoint with the
other preset if you need the machine back (or a faster finish).

## Measured VRAM — Anima 2B `background` (gate C, 2026-07-12)

Live 120-step run of `presets/anima_lora_background.json` settings
(res [512, 768, 1024] buckets, batch 1 + accum 4, caching on, low_vram,
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
