#!/usr/bin/env python3
"""Attention-backend probe for Krea 2 (fork-only diagnostic).

Answers, by measurement on the card in front of you, the question musubi-tuner's
flag list raises: would flash_attn / xformers / SageAttention speed up training
here the way ``--flash_attn`` / ``--sage_attn`` / ``--xformers`` do there?

Why a probe rather than an opinion. Krea 2's attention
(``extensions_built_in/diffusion_models/krea2/src/mmdit.py``) calls
``F.scaled_dot_product_attention`` inside an explicit ``sdpa_kernel`` PRIORITY
list — cuDNN, then flash, then mem-efficient, then math — and passes
``enable_gqa`` (48 query heads over 12 kv heads) plus, when captions are padded
to different lengths in a batch, a (B,1,L,L) key-padding mask. Two consequences
that decide the whole question and are easy to get wrong from first principles:

  * a non-None ``attn_mask`` makes the FlashAttention backend INELIGIBLE in
    PyTorch's dispatcher, so a masked step silently runs on cuDNN/efficient/math
    no matter what any flag says; and
  * ``train.attention_backend`` (TrainConfig, applied in BaseSDTrainProcess via
    ``set_attention_backend``) is a **no-op for Krea 2** — that setter exists on
    diffusers modules and on the ideogram4 transformer, not on Krea 2's
    ``SingleStreamDiT``. Setting it changes nothing for this arch.

So this script reports which kernel the dispatcher actually picks at Krea 2's
real shapes, times every backend that is eligible, and — if they are installed —
times flash_attn / xformers / sageattention at the same shapes for comparison.

SageAttention is included for completeness and is expected to LOSE the argument
rather than the benchmark: upstream SageAttention implements the forward pass
only (no backward), so it cannot serve a training step at all. In musubi it
accelerates sample generation. The trainable INT8 variant in the literature
(SageBwd) is not what ``pip install sageattention`` gives you.

Usage (repo root, inside the training venv):
    python scripts/attn_probe.py
    python scripts/attn_probe.py --resolution 1024 --text-tokens 256 --masked
    python scripts/attn_probe.py --dtype fp16 --iters 50 --json out.json

Shapes default to Krea 2's: 48 heads / 12 kv heads / head_dim 128, image tokens
= (res / 8 / 2)^2 (f8 VAE, patch 2), prepended by --text-tokens text tokens.
CPU-only machines run it too (math backend only), which is useless for timing
but proves the script works.
"""

import argparse
import json
import platform
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Krea 2 reference geometry (KREA2_MMDIT_CONFIG in krea2/krea2.py):
#   features 6144, heads 48, kvheads 12  ->  head_dim = 6144 / 48 = 128
HEADS = 48
KV_HEADS = 12
HEAD_DIM = 128
VAE_DOWNSCALE = 8
PATCH = 2

DTYPES = {"bf16": "bfloat16", "fp16": "float16", "fp32": "float32"}


def image_tokens(resolution: int) -> int:
    side = resolution // VAE_DOWNSCALE // PATCH
    return side * side


def _time(fn, iters: int, warmup: int, torch) -> float:
    """Median ms per call. CUDA-synchronised when on GPU."""
    import statistics
    import time

    cuda = torch.cuda.is_available()
    for _ in range(warmup):
        fn()
    if cuda:
        torch.cuda.synchronize()
    samples = []
    for _ in range(iters):
        t0 = time.perf_counter()
        fn()
        if cuda:
            torch.cuda.synchronize()
        samples.append((time.perf_counter() - t0) * 1000.0)
    return statistics.median(samples)


def build_tensors(args, torch):
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = getattr(torch, DTYPES[args.dtype])
    seq = args.text_tokens + image_tokens(args.resolution)
    q = torch.randn(1, HEADS, seq, HEAD_DIM, device=device, dtype=dtype)
    k = torch.randn(1, KV_HEADS, seq, HEAD_DIM, device=device, dtype=dtype)
    v = torch.randn(1, KV_HEADS, seq, HEAD_DIM, device=device, dtype=dtype)
    mask = None
    if args.masked:
        # what _mask() in mmdit.py produces: a (B,1,L,L) key-padding mask
        keep = torch.ones(1, seq, device=device, dtype=dtype)
        keep[:, args.text_tokens // 2 : args.text_tokens] = 0  # some padded caption slots
        mask = (keep.unsqueeze(1).unsqueeze(2) * keep.unsqueeze(1).unsqueeze(3)).bool()
    return q, k, v, mask, device, dtype, seq


def probe_sdpa(q, k, v, mask, args, torch):
    """Time each SDPA backend in isolation; report which ones are even eligible."""
    import torch.nn.functional as F
    from torch.nn.attention import SDPBackend, sdpa_kernel

    backends = [
        ("cudnn", SDPBackend.CUDNN_ATTENTION),
        ("flash", SDPBackend.FLASH_ATTENTION),
        ("efficient", SDPBackend.EFFICIENT_ATTENTION),
        ("math", SDPBackend.MATH),
    ]
    results = {}
    for name, backend in backends:
        def call(backend=backend):
            with sdpa_kernel([backend]):
                return F.scaled_dot_product_attention(
                    q, k, v, attn_mask=mask, enable_gqa=True
                )
        try:
            call()
        except Exception as exc:  # noqa: BLE001 - the whole point is why it failed
            results[name] = {"eligible": False, "reason": type(exc).__name__ + ": " + str(exc).split("\n")[0][:160]}
            continue
        results[name] = {"eligible": True, "ms": round(_time(call, args.iters, args.warmup, torch), 4)}
    return results


def probe_priority_list(q, k, v, mask, args, torch):
    """Time the exact call Krea 2 makes: the cuDNN-first priority list."""
    import torch.nn.functional as F
    from torch.nn.attention import SDPBackend, sdpa_kernel

    order = [
        SDPBackend.CUDNN_ATTENTION,
        SDPBackend.FLASH_ATTENTION,
        SDPBackend.EFFICIENT_ATTENTION,
        SDPBackend.MATH,
    ]

    def call():
        with sdpa_kernel(order, set_priority=True):
            return F.scaled_dot_product_attention(q, k, v, attn_mask=mask, enable_gqa=True)

    call()
    return {"ms": round(_time(call, args.iters, args.warmup, torch), 4)}


def probe_third_party(q, k, v, mask, args, torch):
    """flash_attn / xformers / sageattention, if installed. Never a hard failure."""
    out = {}

    # These three take (B, L, H, D); Krea 2 holds (B, H, L, D). Transpose, and
    # materialise the GQA expansion they do not all do for you.
    def bhld_to_blhd(t, repeat_to=None):
        if repeat_to is not None and t.shape[1] != repeat_to:
            t = t.repeat_interleave(repeat_to // t.shape[1], dim=1)
        return t.transpose(1, 2).contiguous()

    qb = bhld_to_blhd(q)
    kb = bhld_to_blhd(k, repeat_to=HEADS)
    vb = bhld_to_blhd(v, repeat_to=HEADS)

    try:
        from flash_attn import flash_attn_func

        if mask is not None:
            out["flash_attn"] = {"available": True, "usable": False,
                                 "reason": "padding mask present; flash_attn_func takes no attn_mask "
                                           "(varlen API only, which Krea 2 does not use)"}
        else:
            def call():
                return flash_attn_func(qb, kb, vb)
            call()
            out["flash_attn"] = {"available": True, "usable": True,
                                 "ms": round(_time(call, args.iters, args.warmup, torch), 4)}
    except ImportError:
        out["flash_attn"] = {"available": False}
    except Exception as exc:  # noqa: BLE001
        out["flash_attn"] = {"available": True, "usable": False, "reason": str(exc).split("\n")[0][:160]}

    try:
        import xformers.ops as xops

        def call():
            return xops.memory_efficient_attention(qb, kb, vb)
        call()
        out["xformers"] = {"available": True, "usable": True,
                           "ms": round(_time(call, args.iters, args.warmup, torch), 4)}
    except ImportError:
        out["xformers"] = {"available": False}
    except Exception as exc:  # noqa: BLE001
        out["xformers"] = {"available": True, "usable": False, "reason": str(exc).split("\n")[0][:160]}

    try:
        import sageattention  # noqa: F401
        from sageattention import sageattn

        def call():
            return sageattn(qb, kb, vb, tensor_layout="NHD")
        call()
        out["sageattention"] = {
            "available": True,
            "usable_for_inference": True,
            "usable_for_training": False,
            "reason": "forward-only kernel, no backward pass — cannot serve a training step. "
                      "In musubi --sage_attn accelerates SAMPLING, not the optimiser step.",
            "ms_forward_only": round(_time(call, args.iters, args.warmup, torch), 4),
        }
    except ImportError:
        out["sageattention"] = {"available": False,
                                "note": "forward-only upstream; would not accelerate training even if installed"}
    except Exception as exc:  # noqa: BLE001
        out["sageattention"] = {"available": True, "usable_for_training": False,
                                "reason": str(exc).split("\n")[0][:160]}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--resolution", type=int, default=1024, help="training resolution (default 1024)")
    ap.add_argument("--text-tokens", type=int, default=256, help="text tokens prepended to the image sequence")
    ap.add_argument("--dtype", choices=sorted(DTYPES), default="bf16")
    ap.add_argument("--masked", action="store_true",
                    help="include the (B,1,L,L) key-padding mask Krea 2 builds for ragged caption batches")
    ap.add_argument("--iters", type=int, default=30)
    ap.add_argument("--warmup", type=int, default=5)
    ap.add_argument("--json", type=Path, default=None, help="also write the raw results here")
    args = ap.parse_args()

    try:
        import torch
    except ImportError:
        print("torch is not installed in this interpreter — run from the training venv.", file=sys.stderr)
        return 2

    q, k, v, mask, device, dtype, seq = build_tensors(args, torch)
    report = {
        "host": {"platform": platform.platform(), "torch": torch.__version__, "device": device},
        "shape": {"heads": HEADS, "kv_heads": KV_HEADS, "head_dim": HEAD_DIM,
                  "seq_len": seq, "image_tokens": image_tokens(args.resolution),
                  "text_tokens": args.text_tokens, "resolution": args.resolution,
                  "dtype": args.dtype, "masked": args.masked},
    }
    if device == "cuda":
        report["host"]["gpu"] = torch.cuda.get_device_name(0)
        report["host"]["capability"] = ".".join(str(x) for x in torch.cuda.get_device_capability(0))

    report["krea2_priority_list"] = probe_priority_list(q, k, v, mask, args, torch)
    report["sdpa_backends"] = probe_sdpa(q, k, v, mask, args, torch)
    report["third_party"] = probe_third_party(q, k, v, mask, args, torch)

    print(f"device       : {report['host'].get('gpu', device)} "
          f"(torch {torch.__version__}, sm_{report['host'].get('capability', 'n/a').replace('.', '')})")
    print(f"shape        : B1 x H{HEADS}/kv{KV_HEADS} x L{seq} x D{HEAD_DIM}, {args.dtype}"
          f"{', masked' if args.masked else ', no mask'}")
    print(f"krea2 call   : {report['krea2_priority_list']['ms']} ms  "
          f"(cuDNN-first priority list, exactly what mmdit.py runs)")
    print("\nSDPA backends in isolation:")
    for name, res in report["sdpa_backends"].items():
        if res.get("eligible"):
            print(f"  {name:<10} {res['ms']:>9.4f} ms")
        else:
            print(f"  {name:<10} INELIGIBLE  {res['reason']}")
    print("\nThird-party kernels:")
    for name, res in report["third_party"].items():
        if not res.get("available"):
            print(f"  {name:<14} not installed{'  — ' + res['note'] if res.get('note') else ''}")
        elif res.get("ms") is not None:
            print(f"  {name:<14} {res['ms']:>9.4f} ms")
        elif res.get("ms_forward_only") is not None:
            print(f"  {name:<14} {res['ms_forward_only']:>9.4f} ms (FORWARD ONLY — {res['reason']})")
        else:
            print(f"  {name:<14} unusable here — {res.get('reason', 'unknown')}")
    print("\nReminder: train.attention_backend is a NO-OP for Krea 2 (no set_attention_backend "
          "on SingleStreamDiT). Attention for this arch is whatever the dispatcher picks above.")

    if args.json:
        args.json.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
