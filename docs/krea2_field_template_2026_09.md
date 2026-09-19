# Krea 2: a field-proven musubi-tuner template (recovered 2026-09-19)

Fork-only document. This is the *source record* for `presets/krea2_character_lora.json` and
for the Krea 2 corroboration notes in `ui/src/utils/stepSuggestion.ts`. It exists because
every other Krea 2 number in this fork traces back to published guidance or to one 36-image
write-up; this one traces back to a set of runs whose **output** the operator judged good
("they came out great") across multiple characters, which is a different and stronger kind of
evidence — and the only reason to trust it is provenance, so the provenance is written down.

It is still **not a measurement on this trainer.** The runs were musubi-tuner
(`krea2_train_network.py`) on RunPod 4090/H100, so the recipe transfers and the
implementation does not. Nothing in this document was reproduced here.

## 1. The template as recovered

Reproduced verbatim in substance, reordered only for grouping. Ellipses in the original
("generally", "earlier runs", "later configs") are preserved — they are the uncertainty, and
flattening them into single numbers would be inventing precision.

| Field | Value as recovered |
|---|---|
| Trainer | Musubi Tuner / `krea2_train_network.py` |
| Hardware | RunPod — mix of RTX 4090 and H100 |
| Base model | Krea 2 raw BF16 |
| Text encoder | Qwen3-VL 4B BF16 |
| VAE | HunyuanVideo 3D causal VAE |
| Dataset | ~30–70 curated images per character, paired `.txt` captions |
| Resolution | multi-aspect / bucketed, not forced square |
| Repeats | one documented 70-image setup used 10 repeats (700 training items/epoch) |
| Steps | generally ~2,200 |
| LoRA rank/alpha | earlier runs 16/16; later runs also tested rank 32 / alpha 16 |
| Optimizer | AdamW8bit |
| Learning rate | earlier runs 1e-4; later configs also 2e-4 |
| Precision | BF16 training with scaled FP8 base weights |
| Attention | PyTorch SDPA |
| Memory | gradient checkpointing (later configuration) |
| Caching | VAE latents + Qwen3-VL text embeddings cached before training |
| Checkpointing | intermediate checkpoints saved throughout, then tested for likeness/generalization |

## 2. Translation to this trainer

| Template | This trainer | Note |
|---|---|---|
| `krea2_train_network.py` | `arch: krea2`, `type: diffusion_trainer` | Different implementation of the same model |
| Qwen3-VL 4B TE, HunyuanVideo 3D causal VAE | **not configurable** | `arch: krea2` wires Qwen3-VL-4B-Instruct + the **Qwen-Image** VAE (f8, 16ch) — `extensions_built_in/diffusion_models/krea2/krea2.py` docstring. The VAE naming is the one unresolved discrepancy; see §4 |
| BF16 + scaled FP8 base weights | `train.dtype: bf16` + `model.quantize: true`, `qtype: qfloat8` (same for `_te`) | `qfloat8` is quanto's scaled fp8, the nearest equivalent |
| PyTorch SDPA | default | No flag; this trainer does not expose an attention selector for Krea 2 |
| multi-aspect / bucketed | `datasets[].buckets: true` (the default), `resolution: [1024]` | Set explicitly in the preset for the avoidance of doubt. 1024 not 768: Krea 2's own training resolutions are 256/512/1024 (two-source, see the advisor notes) |
| gradient checkpointing | `train.gradient_checkpointing: true` | Already the default in every Krea 2 preset here |
| cache latents + text embeds | `datasets[].cache_latents` + `cache_latents_to_disk`, `train.cache_text_embeddings: true` | `train.cache_text_embeddings` propagates to every dataset (`BaseSDTrainProcess.py:153`) and all datasets must agree (`config_modules.py:1579`) |
| AdamW8bit, LR 1e-4 / 2e-4 | `train.optimizer: adamw8bit`, `train.lr` | Unchanged |
| rank 16/16, rank 32/alpha 16 | `network.linear` / `linear_alpha` | Unchanged |
| ~2,200 steps | `train.steps` | But see §3 — the advisor should size this, not the template |
| 10 repeats | **do not transfer** — leave `num_repeats: 1` | Step-bounded trainer; repeats only duplicate the file list (`toolkit/data_loader.py`) |
| intermediate checkpoints, tested | `save.save_every: 250` + `max_step_saves_to_keep: 9` | 9 covers a 2200-step run end to end; raise it if you lengthen the run |

## 3. What it corroborates, and where it disagrees

**Effective LR: three routes, one number.** LoRA output scales as `alpha / rank`
(`toolkit/lora_special.py:116`, `_set_runtime_scale(alpha / lora_dim)`), so the quantity that
governs how fast the adapter moves is `alpha/rank × LR`:

| Config | scale | LR | product |
|---|---|---|---|
| Template, earlier runs: 16/16 @ 1e-4 | 1.0 | 1e-4 | **1e-4** |
| Template, later runs: 32/16 @ 2e-4 | 0.5 | 2e-4 | **1e-4** |
| This fork's advisor + presets: 32/32 @ 1e-4 | 1.0 | 1e-4 | **1e-4** |

The template's two configurations and this fork's recipe are the same effective learning
rate, reached three different ways. That is the single most useful thing in this document:
the fork's Krea 2 LR was previously corroborated only by guides, and it now has an output-
judged anchor. (The caveat on the arithmetic: with Adam the update magnitude is roughly `lr`
regardless of gradient scale, so `alpha/rank × lr` is the standard *heuristic* for effective
step size, not an identity. Rank 32 at scale 0.5 still has twice the capacity of rank 16 at
scale 1.0 — same speed, different ceiling. That is the reason to prefer 32/16 for a
character, and it is why the new preset ships that pair rather than 16/16.)

**Steps: agreement at 70 images, divergence at 30.** The template holds ~2,200 steps roughly
constant across its 30–70 image range, at batch 1. Per unique image that is:

| Images | Passes/image at 2200 steps | Advisor target (`ARCH_HEURISTICS.krea2`) | Advisor steps |
|---|---|---|---|
| 70 | 31.4 | 32 (medium tier) | 2240 |
| 50 | 44.0 | 32 (medium tier) | 1600 |
| 30 | 73.3 | 32 (medium tier) | 960 |

At the 70-image end the two agree to within 2%, independently of the 36-image musubi run
that anchored the medium tier in the first place — two unrelated runs, same trainer family,
landing on ~32 passes/image. At the 30-image end the template runs 2.3× the advisor's number.
Both were reported as good outputs, which is the honest state of it: the fork's tiering and a
flat 2200 bracket the same band (31–73 passes) from opposite directions, and nothing here
resolves which is right below ~50 images. **Not changed:** the tier numbers stay as they are.
A fixed step count across a 2.3× dataset-size range is exactly the shape the tiering exists to
replace, and one operator's step count is not evidence against a measured exposure target.

**Repeats: the concrete example the advisor's `REPEATS_NOTE` was written for.** 70 images ×
10 repeats = 700 items/epoch, 2200 steps ≈ 3.1 epochs — all of it epoch-bounded accounting
that means nothing here. Copied literally into this trainer at `num_repeats: 10`, the same
job trains identically (repeats only lengthen the file list) but the advisor reads 700 files,
tiers it `large`, and the step math moves under you for no reason.

## 4. Open / unresolved

1. ~~**VAE naming.**~~ **RESOLVED 2026-09-19** — the template is wrong and the transfer is
   sound. musubi-tuner's own `docs/krea2.md` specifies the **Qwen-Image VAE**
   (`split_files/vae/qwen_image_vae.safetensors`) and **Qwen3-VL-4B-Instruct** as the text
   encoder, i.e. exactly what `arch: krea2` wires here. The "HunyuanVideo 3D causal VAE" line
   is almost certainly a carry-over from musubi's own heritage — the repo began as a
   HunyuanVideo trainer and still ships that VAE for the video archs. Both trainers encode
   Krea 2 latents the same way, so every step/LR transfer in section 3 stands unweakened.
2. **Batch size is not in the recovered template.** Everything in §3 assumes batch 1, which is
   musubi's default and what `batchAdvisor.ts` records as the measured Krea 2 ceiling on 16 GB.
   If those runs were batch 2 on the H100, every passes/image figure above doubles.
3. **2e-4 vs 1e-4 was never A/B'd** at fixed alpha/rank by the operator — the LR moved when
   the alpha did. Treat the row-three arithmetic as the explanation, not as a measurement.
4. **Nothing reproduced on this trainer.** No Krea 2 run in this fork has been made at 32/16.

## 5. Dataset prep and checkpoint selection (second comment, same operator, 2026-09-19)

The first comment was the trainer config. The second is the half that produced the dataset it
consumed — and on this operator's own account the prep was ad-hoc ("the scripts barely
worked"), with at least one image trained caption-less because a script failed silently and
nobody caught it. Recorded as method, not as a validated pipeline.

**Captioning.** `microsoft/Florence-2-large`, task token `<DETAILED_CAPTION>`,
`max_new_tokens=128`, `num_beams=3`. Then a caption surgery pass:

- **Identity attributes deliberately removed** — eye colour, hair colour, skin tone, and the
  generic `woman` / `girl` / `female` nouns. Stated intent: force those traits into the
  identity token instead of letting the caption carry them.
- **Boilerplate and background removed** — the cleanup script keeps only the **first
  sentence** and cuts clauses starting with things like "in the background".
- **One randomly chosen alias per image** from that character's alias set, prepended as the
  identity trigger (`dojacat, doja cat`; `miranda cosgrove, miranda`) — a trigger *set*
  sampled per image, not one fixed token on every caption.

**Face-crop augmentation.** OpenCV Haar frontal-face detection finds the largest face, applies
generous headshot margins, and writes a `_facecrop` copy **only when the crop differs
meaningfully from the original**. The copy inherits the original's caption, which is then
rewritten to drop clothing/body/pose detail that is no longer visible, with
`close up portrait` appended. Existing `_facecrop` files are skipped on later passes so the
pipeline cannot crop its own crops. Finally every directory whose name contains `_dataset` is
zipped for upload to RunPod.

**Checkpoint selection.** Explicitly *not* "take the last one". Intermediates were tested
across portraits, varied angles, expressions, action and environment changes, **and varied
LoRA strengths**, then picked on likeness vs generalization. This is what
`save_every: 250` + `max_step_saves_to_keep: 9` in `presets/krea2_character_lora.json` exists
to support, and it is the reason the ~2200 step count should be read as "where the good
checkpoint tended to be", not as a target to land exactly on.

**What this corroborates.** `ARCH_RECIPES.krea2` already advised keeping invariant identity
attributes out of captions, flagged as a plausible hypothesis from the 36-image run's control
grid that its author never re-ran. A second, unrelated operator doing precisely that on
purpose — and reporting good likeness — makes it two-source. It is still not a controlled
test: nobody has run the A/B against un-stripped captions on either side.

## 6. What this fork already has, and what it does not

| Pipeline stage | In this fork | Gap |
|---|---|---|
| Missing / empty caption detection | **Yes** — `scripts/preflight.py` errors on an image with no `.txt` sidecar, warns on an empty one; wired into the UI as the Dataset Tools pre-flight panel (advisory-only by decision) | None. This is exactly the silent failure the operator hit, and it is already caught — but only if the check is run |
| Auto-captioning | **Partly** — `scripts/auto_caption.py` (WD14 tagger, comma-separated tags) and upstream's captioner extension (Qwen3-VL, Qwen2.5/3-Omni, Ideogram4) | **No Florence-2 `<DETAILED_CAPTION>`** in the fork's toolchain. Upstream ships it only inside `flux_train_ui.py`, a standalone Gradio app that is not part of this UI. Natural-language detail captions currently mean Qwen3-VL here, not Florence-2 |
| Trigger word on captions | **Partly** — `auto_caption.py --trigger-word WORD` prepends one fixed token | **No alias set, no per-image random selection** |
| Identity-attribute stripping / boilerplate + background removal / first-sentence truncation | **No** | Whole caption-surgery stage is absent. The advisor recommends the practice; nothing implements it |
| Face-crop augmentation (`_facecrop` copies, caption rewrite, skip-existing) | **No** — `scripts/smart_prep.py` does subject-aware crop-to-bucket of whole images (U2Net, head-first anchor), which is a different operation: it *replaces* an image, it does not *add* a headshot copy | Whole stage absent |
| Multi-aspect bucketing | **Yes** — native, `datasets[].buckets` defaults true. No pre-cropping needed | None; `smart_prep.py` is for extreme aspect ratios only |
| Zip a dataset folder | **Yes** — `ui/src/app/api/zip/route.ts` | None |

Nothing above is built. This table is the scope of what a fork-side port of the prep pipeline
would cover, and the reason it would be worth building is the middle three rows.

## 7. Is musubi-tuner the better trainer? (researched 2026-09-19)

Asked because every Krea 2 source this fork trusts — the 36-image run, the field template —
is a musubi-tuner run, which raises the obvious question of whether this repo is the wrong
tool. Read against musubi's own `docs/krea2.md` and README (kohya-ss/musubi-tuner).

**Verdict: not better, differently shaped.** musubi is a CLI research trainer with a lower
VRAM floor and more knobs; ai-toolkit is a GUI trainer with a scheduler, a dataset pipeline
and this fork's advisory layer on top. On Krea 2 specifically the two agree on the recipe,
which is the strongest argument that the choice is about workflow, not output.

**Where they agree (and it is most of it).** musubi's own doc recommends **rank/alpha 32**
(`--network_dim 32 --network_alpha 32`), **adamw8bit**, **LR 1e-4**, `--fp8_base --fp8_scaled`,
`--gradient_checkpointing`, `--sdpa`, Qwen-Image VAE + Qwen3-VL-4B-Instruct, latents and text
encoder outputs pre-cached. That is, line for line, what `presets/krea2_lora_low_vram.json`
and `ARCH_RECIPES.krea2` already say. The field template's numbers were never in tension with
this fork's; they were the same recipe run on the other implementation.

**Where musubi is genuinely ahead.**

- **VRAM floor.** `--blocks_to_swap N` (up to 26) streams DiT blocks to CPU and gets Krea 2
  onto 12 GB. This fork's answer is `low_vram` + `layer_offloading_transformer_percent`
  (0.35 in `krea2_lora_16gb`) + qfloat8, which is the same idea with coarser control and a
  practical floor of 16 GB. If a 12 GB card ever has to train Krea 2, musubi is the tool.
- **Attention backends.** `--flash_attn`, `--sage_attn`, `--xformers`, `--split_attn` against
  SDPA only here. The field template used SDPA, so this bought those runs nothing.
- **Multi-GPU** via Accelerate. No equivalent here.
- **Exact resume.** `--resume` restores optimizer and scheduler state to the step. This
  trainer resumes from the latest save plus metadata, which is not the same guarantee.
- **`--convrot_int8`** as an fp8 alternative, and `--compile`.
- **Reach.** Video archs (HunyuanVideo, Wan 2.1/2.2, FramePack), which this repo does not
  cover in the same depth.

**Where this fork is ahead.**

- **The GUI, the job queue and sampling** — which is the operator's stated reason for being
  here, and not a small one: musubi ships no official GUI (the Gradio front-ends are
  third-party forks), and its sampling during training needs `--text_encoder` kept resident.
- **The advisory layer this fork built**: step suggestion tiered by dataset size, the
  effective-batch gate, the machine-aware batch plan, and ~40 presets with provenance. musubi
  gives you flags and a TOML; nothing tells you 2200 steps is 2.3× hot for 30 images.
- **LoKr, Differential Output Preservation, regularization datasets, Automagic v3** — the
  levers for exactly the identity-bleed problem these character LoRAs hit.
- **Dataset tooling in-app** (pre-flight, captioning, prep panel) versus assembling a TOML.
- **Stability posture.** musubi's README calls itself experimental, under active development,
  with breaking changes, and "not intended for production use".

**The one setting worth re-examining because of this.** musubi's Krea 2 doc recommends
`--timestep_sampling shift --discrete_flow_shift 2.5` as the baseline ("matches the K2
inference time-shift at 1024×1024"), or `--timestep_sampling krea2_shift` for a
resolution-aware schedule. Every Krea 2 preset here ships `timestep_type: linear`, sourced
from LoRA Dataset Studio / RunComfy calling linear "Krea-canonical". This fork already
implements the other side: `timestep_type: shift` in
`toolkit/samplers/custom_flowmatch_sampler.py` is commented "matches inference dynamic
shifting" and reads the Krea-specific exponential mu endpoints
(`base_shift` 0.5 → `max_shift` 1.15, `use_dynamic_shifting: true`) that
`extensions_built_in/diffusion_models/krea2/krea2.py` sets — i.e. ai-toolkit's `shift` IS
musubi's resolution-aware `krea2_shift`, and upstream's 2026-09-16 `patch_size` fix is what
made it compute the right token count. So the two trainers' defaults disagree on a setting
both support, with one source each. **Not resolved here** — it wants an A/B on the same
dataset, and nothing in the field template says which sampling its good runs used.

**Bottom line.** Switching trainers would trade a GUI, the advisor and the identity-bleed
levers for a 12 GB floor, multi-GPU and exact resume. On a 5090 none of what musubi wins is
binding. Take the timestep question from it; leave the rest.
