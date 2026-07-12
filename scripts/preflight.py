"""Dataset pre-flight validator (spec Workstream B1, ported from Anima-TrainFlow).

Usage:
    python scripts/preflight.py <dataset_dir> [options]
    python scripts/preflight.py --config <job.yaml|job.json> [options]

Validates dataset folders (and, with --config, the job's model paths) before a
training run. Architecture-agnostic: works for SDXL / FLUX.2 Klein / Krea 2 /
Anima datasets alike.

Checks (E = error → exit 1, W = warning → exit 0):
  E dataset folder missing / contains no images
  E image files that fail to open (corrupt)
  E images missing their caption sidecar (unless --allow-missing-captions)
  W captions that are empty/whitespace
  W images >= --max-side px on either side (ai-toolkit buckets & downscales,
    so this is a perf warning, not the hard error TrainFlow made it)
  W unexpected file types in the dataset folder
  E (--config) datasets[].folder_path entries, recursively checked
  E (--config) model.name_or_path that looks like a local path but is missing
    (HuggingFace repo ids are skipped with a note)

--warn-only downgrades every error to a warning and always exits 0 — the
override hook for wiring this into a job-launch path later.
"""

import argparse
import json
import sys
from pathlib import Path

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
# non-image files that are expected/harmless in a dataset folder
IGNORED_EXTS = {".txt", ".npz", ".json", ".csv"}
IGNORED_NAMES = {"_latent_cache", "_text_embedding_cache", ".aitk_size.json"}


class Report:
    def __init__(self, warn_only: bool):
        self.errors = []
        self.warnings = []
        self.warn_only = warn_only

    def error(self, msg: str):
        (self.warnings if self.warn_only else self.errors).append(msg)

    def warn(self, msg: str):
        self.warnings.append(msg)

    def print_and_exit(self):
        for w in self.warnings:
            print(f"WARN  {w}")
        for e in self.errors:
            print(f"ERROR {e}")
        if self.errors:
            print(f"\npre-flight FAILED: {len(self.errors)} error(s), "
                  f"{len(self.warnings)} warning(s)")
            sys.exit(1)
        print(f"\npre-flight OK: 0 errors, {len(self.warnings)} warning(s)")
        sys.exit(0)


def check_dataset(folder: Path, caption_ext: str, max_side: int,
                  allow_missing_captions: bool, report: Report):
    from PIL import Image

    label = str(folder)
    if not folder.is_dir():
        report.error(f"[{label}] dataset folder not found")
        return

    images, strangers = [], []
    for f in sorted(folder.iterdir()):
        if f.is_dir() or f.name in IGNORED_NAMES:
            continue
        ext = f.suffix.lower()
        if ext in IMAGE_EXTS:
            images.append(f)
        elif ext not in IGNORED_EXTS and f".{caption_ext.lstrip('.')}" != ext:
            strangers.append(f.name)

    if not images:
        report.error(f"[{label}] no images found "
                     f"(supported: {', '.join(sorted(IMAGE_EXTS))})")
        return

    cap_suffix = "." + caption_ext.lstrip(".")
    missing_caps, empty_caps, corrupt, oversized = [], [], [], []
    for img in images:
        cap = img.with_suffix(cap_suffix)
        if not cap.exists():
            missing_caps.append(img.name)
        elif not cap.read_text(encoding="utf-8", errors="replace").strip():
            empty_caps.append(cap.name)
        try:
            with Image.open(img) as im:
                w, h = im.size
            if w >= max_side or h >= max_side:
                oversized.append(f"{img.name} ({w}x{h})")
        except Exception as e:
            corrupt.append(f"{img.name} ({type(e).__name__})")

    print(f"[{label}] {len(images)} images")
    if corrupt:
        report.error(f"[{label}] {len(corrupt)} unreadable image(s): "
                     + ", ".join(corrupt[:5]) + ("…" if len(corrupt) > 5 else ""))
    if missing_caps:
        msg = (f"[{label}] {len(missing_caps)} image(s) missing {cap_suffix} captions: "
               + ", ".join(missing_caps[:5]) + ("…" if len(missing_caps) > 5 else ""))
        if allow_missing_captions:
            report.warn(msg)
        else:
            report.error(msg)
    if empty_caps:
        report.warn(f"[{label}] {len(empty_caps)} empty caption file(s)")
    if oversized:
        report.warn(f"[{label}] {len(oversized)} image(s) >= {max_side}px — "
                    f"training works (bucketed + downscaled) but caching is slower; "
                    f"consider pre-resizing: "
                    + ", ".join(oversized[:5]) + ("…" if len(oversized) > 5 else ""))
    if strangers:
        report.warn(f"[{label}] {len(strangers)} unexpected file(s) ignored by the "
                    f"trainer: " + ", ".join(strangers[:5])
                    + ("…" if len(strangers) > 5 else ""))


def load_config(path: Path):
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        return json.loads(text)
    import yaml
    return yaml.safe_load(text)


def looks_like_local_path(s: str) -> bool:
    # HF repo ids are "org/name" with no drive letter, backslash, extension or
    # more than one slash
    if "\\" in s or s.endswith((".safetensors", ".ckpt", ".pt", ".gguf")):
        return True
    if len(s) > 1 and s[1] == ":":  # windows drive
        return True
    return s.count("/") != 1 or s.startswith((".", "/", "~"))


def check_job_config(cfg_path: Path, args, report: Report):
    try:
        cfg = load_config(cfg_path)
    except Exception as e:
        report.error(f"[{cfg_path}] config unreadable: {e}")
        return
    processes = (cfg.get("config") or {}).get("process") or []
    if not processes:
        report.error(f"[{cfg_path}] no config.process entries found")
        return
    for proc in processes:
        model = proc.get("model") or {}
        name_or_path = model.get("name_or_path")
        if name_or_path:
            if looks_like_local_path(str(name_or_path)):
                if not Path(name_or_path).exists():
                    report.error(f"[model] path not found: {name_or_path}")
            else:
                print(f"[model] HuggingFace repo id '{name_or_path}' — "
                      f"existence not checked (resolved at load time)")
        datasets = proc.get("datasets") or []
        if not datasets:
            report.error(f"[{cfg_path}] process has no datasets")
        for ds in datasets:
            folder = ds.get("folder_path")
            if not folder:
                report.error(f"[{cfg_path}] dataset entry missing folder_path")
                continue
            check_dataset(Path(folder), ds.get("caption_ext", "txt"),
                          args.max_side, args.allow_missing_captions, report)


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("dataset_dir", nargs="?", help="dataset folder to validate")
    p.add_argument("--config", help="job config (yaml/json) to validate instead of "
                                    "or in addition to a bare dataset folder")
    p.add_argument("--caption-ext", default="txt",
                   help="caption extension for bare dataset_dir checks (default: txt)")
    p.add_argument("--max-side", type=int, default=2048,
                   help="warn when an image side is >= this (default: 2048)")
    p.add_argument("--allow-missing-captions", action="store_true",
                   help="downgrade missing captions to a warning")
    p.add_argument("--warn-only", action="store_true",
                   help="report everything but always exit 0 (override flag)")
    args = p.parse_args()

    if not args.dataset_dir and not args.config:
        p.error("provide a dataset_dir and/or --config")

    report = Report(args.warn_only)
    if args.dataset_dir:
        check_dataset(Path(args.dataset_dir), args.caption_ext, args.max_side,
                      args.allow_missing_captions, report)
    if args.config:
        check_job_config(Path(args.config), args, report)
    report.print_and_exit()


if __name__ == "__main__":
    main()
