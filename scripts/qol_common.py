"""Shared helpers for the fork's QoL dataset CLIs (preflight, auto_caption, smart_prep).

Two things live here so they exist exactly once:

- ``list_images`` / ``walk_dataset_files``: dataset discovery that matches the trainer.
  Until 2026-08-29 all three scripts used a flat ``folder.iterdir()`` and skipped
  directories, while ``toolkit/dataset_selection.py`` (what the trainer actually
  enumerates) walks recursively — so on a dataset organised into subfolders
  pre-flight hard-errored "no images found" and the tagger/prep tool silently did
  nothing. Discovery now delegates to that module, so the two cannot drift.
- ``add_torch_cuda_dlls``: the Windows CUDA-DLL shim onnxruntime needs, previously
  copy-pasted into two scripts.

The scripts run from anywhere (`python scripts/x.py`, or spawned by the UI with the
repo as cwd), so the repo root is put on ``sys.path`` here before ``toolkit`` is
imported. ``toolkit/__init__.py`` is light (an HF progress-bar tweak), no torch.
"""

import os
import sys
from pathlib import Path
from typing import Iterable, Iterator, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from toolkit.dataset_selection import list_dataset_media_files  # noqa: E402

# Folders the trainer never reads (toolkit/dataset_selection.py prunes dot-folders and
# `_controls`; the cache folders hold .npz/.safetensors, not images, but a "stray file"
# scan must not report their contents either).
CACHE_DIR_NAMES = {"_latent_cache", "_text_embedding_cache"}


def list_images(
    folder: Path,
    extensions: Iterable[str],
    include_loose_files: bool = True,
    include_subfolders: Optional[Iterable[str]] = None,
) -> List[Path]:
    """Every image the trainer would train on under ``folder``, sorted.

    Same walk as the trainer: recursive, dot-folders and ``_controls`` pruned,
    optional child-folder scope. ``extensions`` are matched case-insensitively.
    """
    files = list_dataset_media_files(
        str(folder),
        [e if e.startswith(".") else f".{e}" for e in extensions],
        include_loose_files=include_loose_files,
        include_subfolders=include_subfolders,
    )
    return sorted(
        (Path(f) for f in files if Path(f).parent.name not in CACHE_DIR_NAMES),
        key=lambda p: str(p).lower(),
    )


def walk_dataset_files(folder: Path) -> Iterator[Path]:
    """Every regular file the trainer's walk would visit (any extension), for
    stray-file reporting. Mirrors the pruning in ``toolkit/dataset_selection.py``
    plus the cache folders above."""
    for root, dirs, files in os.walk(folder):
        dirs[:] = sorted(
            d for d in dirs
            if not d.startswith(".") and d != "_controls" and d not in CACHE_DIR_NAMES
        )
        for name in sorted(files):
            if name.startswith("."):
                continue
            yield Path(root) / name


def rel_label(path: Path, folder: Path) -> str:
    """``path`` relative to ``folder`` with forward slashes — what the messages show
    so a nested file is identifiable, not just its basename."""
    try:
        return path.relative_to(folder).as_posix()
    except ValueError:
        return path.name


def add_torch_cuda_dlls() -> None:
    """Let onnxruntime's CUDA provider find the CUDA/cuDNN DLLs bundled with the
    torch wheel (they aren't on PATH on Windows). No-op elsewhere."""
    try:
        import torch
    except ImportError:
        return
    lib = Path(torch.__file__).parent / "lib"
    if lib.is_dir() and hasattr(os, "add_dll_directory"):
        os.add_dll_directory(str(lib))


def split_buckets_arg(value: str) -> Tuple[int, int]:
    """Parse smart_prep's ``MINxMAX`` bucket profile. Raises ValueError with the
    message the CLI prints."""
    try:
        side_min, side_max = (int(x) for x in value.lower().split("x"))
    except ValueError:
        raise ValueError("--buckets must look like 512x768")
    if side_min % 64 or side_max % 64 or side_min > side_max:
        raise ValueError("--buckets sides must be multiples of 64 with MIN <= MAX")
    return side_min, side_max
