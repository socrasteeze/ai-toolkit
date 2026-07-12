"""Dump sorted LoRA safetensors keys + shapes (Anima A3 key-parity helper).

Usage:
  python scripts/dump_lora_keys.py path/to/lora.safetensors
  python scripts/dump_lora_keys.py a.safetensors b.safetensors   # key/shape diff

Exit codes:
  0 — single dump ok, or two files match (names + shapes)
  1 — usage / load error, or two-file mismatch
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def load_keys(path: Path) -> dict[str, tuple]:
    from safetensors.torch import load_file

    sd = load_file(str(path))
    return {k: tuple(v.shape) for k, v in sd.items()}


def dump(path: Path) -> dict[str, tuple]:
    keys = load_keys(path)
    print(f"# {path}  ({len(keys)} tensors)")
    for k in sorted(keys):
        print(f"{k}  {keys[k]}")
    return keys


def diff(a: Path, b: Path) -> int:
    ka, kb = load_keys(a), load_keys(b)
    only_a = sorted(set(ka) - set(kb))
    only_b = sorted(set(kb) - set(ka))
    shape_mismatch = sorted(
        k for k in set(ka) & set(kb) if ka[k] != kb[k]
    )

    print(f"# compare\n#   a={a} ({len(ka)} keys)\n#   b={b} ({len(kb)} keys)")
    if only_a:
        print(f"\nonly in a ({len(only_a)}):")
        for k in only_a:
            print(f"  {k}  {ka[k]}")
    if only_b:
        print(f"\nonly in b ({len(only_b)}):")
        for k in only_b:
            print(f"  {k}  {kb[k]}")
    if shape_mismatch:
        print(f"\nshape mismatch ({len(shape_mismatch)}):")
        for k in shape_mismatch:
            print(f"  {k}  a={ka[k]}  b={kb[k]}")

    if not only_a and not only_b and not shape_mismatch:
        print("\nOK: zero key/shape mismatches")
        return 0

    print(
        f"\nFAIL: only_a={len(only_a)} only_b={len(only_b)} "
        f"shape_mismatch={len(shape_mismatch)}"
    )
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lora", nargs="+", type=Path, help="one or two .safetensors")
    args = parser.parse_args()

    if len(args.lora) == 1:
        dump(args.lora[0])
        return 0
    if len(args.lora) == 2:
        return diff(args.lora[0], args.lora[1])
    parser.error("pass one path to dump, or two paths to diff")
    return 1


if __name__ == "__main__":
    sys.exit(main())
