"""U2Net subject-aware bucket resize/crop CLI (spec Workstream B3, ported from
Anima-TrainFlow's SmartCropper).

Usage:
    python scripts/smart_prep.py <in_dir> <out_dir> [--buckets 512x768]
        [--threads 4] [--model-path u2net.onnx]

OPTIONAL prep tool: ai-toolkit already buckets by aspect ratio and never
requires cropping — use this only for extreme-aspect-ratio sources where a
subject-aware (head-first) crop beats a center crop.

For each image, picks the aspect-ratio-closest bucket from
{(min,min)} ∪ {(min,s),(s,min) for s in min+64..max+64 step 64}, then:
- if the aspect already matches: plain INTER_AREA resize;
- else: runs U2Net saliency at 320px, anchors the crop just above the top of
  the detected subject ("head-first") and horizontally on its center of mass,
  then resizes to the bucket.

Walks <in_dir> the way the trainer does (recursively, dot-folders and
`_controls` pruned — see scripts/qol_common.py) and mirrors the subfolder
layout under <out_dir>, so a dataset organised into child folders keeps its
folder scope. Copies caption .txt sidecars alongside outputs (always .png).
U2Net weights (~170 MB) download on first run to ~/.cache/ai-toolkit/u2net.onnx
(the rembg release build). GPU when onnxruntime's CUDA provider initializes,
else CPU.
"""

import argparse
import math
import shutil
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np

from qol_common import add_torch_cuda_dlls, list_images, rel_label, split_buckets_arg

U2NET_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx"
DEFAULT_MODEL_PATH = Path.home() / ".cache" / "ai-toolkit" / "u2net.onnx"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
MASK_THRESH = 0.15
U2NET_INPUT = 320


def get_valid_buckets(side_min: int, side_max: int):
    buckets = {(side_min, side_min)}
    for s in range(side_min + 64, side_max + 64, 64):
        buckets.add((side_min, s))
        buckets.add((s, side_min))
    return sorted(buckets, key=lambda x: x[0] * x[1])


def get_best_bucket(w: int, h: int, buckets):
    log_orig = math.log(w / h)
    return min(buckets, key=lambda b: abs(math.log(b[0] / b[1]) - log_orig))


def ensure_model(path: Path) -> Path:
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading u2net.onnx (~170 MB) -> {path}")
    import urllib.request
    tmp = path.with_suffix(".part")
    urllib.request.urlretrieve(U2NET_URL, tmp)
    tmp.rename(path)
    return path


class SmartCropper:
    def __init__(self, model_path: Path):
        self.model_path = model_path
        self.session = None

    def load_model(self) -> str:
        add_torch_cuda_dlls()
        import onnxruntime as rt
        providers = [("CUDAExecutionProvider", {"device_id": 0}),
                     "CPUExecutionProvider"]
        self.session = rt.InferenceSession(str(self.model_path),
                                           providers=providers)
        return "GPU (CUDA)" if "CUDA" in self.session.get_providers()[0] else "CPU"

    def process_image(self, original_img, tw: int, th: int):
        import cv2
        h_orig, w_orig = original_img.shape[:2]

        if abs((w_orig / h_orig) - (tw / th)) < 0.01:
            return cv2.resize(original_img, (tw, th),
                              interpolation=cv2.INTER_AREA)

        low_res_scale = 1024 / max(h_orig, w_orig)
        img_sm = cv2.resize(
            original_img,
            (int(w_orig * low_res_scale), int(h_orig * low_res_scale)),
            interpolation=cv2.INTER_AREA)

        img_inp = cv2.resize(img_sm, (U2NET_INPUT, U2NET_INPUT),
                             interpolation=cv2.INTER_AREA)
        img_inp = img_inp.astype(np.float32) / 255.0
        img_inp -= [0.485, 0.456, 0.406]
        img_inp /= [0.229, 0.224, 0.225]
        input_tensor = np.expand_dims(np.transpose(img_inp, (2, 0, 1)), 0)

        mask = self.session.run(
            None, {self.session.get_inputs()[0].name: input_tensor})[0][0][0]
        mask = cv2.resize(mask, (img_sm.shape[1], img_sm.shape[0]))

        y_idx, x_idx = np.where(mask > MASK_THRESH)
        if len(y_idx) > 0:
            top_y = int(np.min(y_idx) / low_res_scale)
            center_x = int(np.mean(x_idx) / low_res_scale)
        else:
            top_y, center_x = h_orig // 4, w_orig // 2

        scale = max(tw / w_orig, th / h_orig)
        cw, ch = int(tw / scale), int(th / scale)
        y1 = max(0, min(top_y - int(ch * 0.05), h_orig - ch))
        x1 = max(0, min(center_x - cw // 2, w_orig - cw))

        return cv2.resize(original_img[y1:y1 + ch, x1:x1 + cw], (tw, th),
                          interpolation=cv2.INTER_AREA)


def output_path(img: Path, in_dir: Path, out_dir: Path) -> Path:
    """Where ``img`` lands under ``out_dir``: same relative folder, .png."""
    return (out_dir / img.relative_to(in_dir)).with_suffix(".png")


def plan_tasks(in_dir: Path, out_dir: Path, buckets):
    """Decide what to do for every trainable image under ``in_dir``.

    Returns ``(tasks, skipped, bucket_counts)``: ``tasks`` are
    ``(src, dst, bucket_w, bucket_h)`` tuples still to process; ``skipped`` counts
    outputs already present at their bucket size (resume); ``bucket_counts`` is
    pre-seeded with the skipped ones so the final histogram is complete.
    """
    from PIL import Image

    images = list_images(in_dir, IMAGE_EXTS)
    tasks, bucket_counts, skipped = [], {}, 0
    for img in images:
        try:
            with Image.open(img) as im:
                w, h = im.size
        except Exception as e:
            print(f"WARN unreadable, skipped: {rel_label(img, in_dir)} ({e})")
            continue
        tw, th = get_best_bucket(w, h, buckets)
        out_p = output_path(img, in_dir, out_dir)
        if out_p.exists():
            with Image.open(out_p) as check:
                if check.size == (tw, th):
                    skipped += 1
                    bucket_counts[(tw, th)] = bucket_counts.get((tw, th), 0) + 1
                    continue
        tasks.append((img, out_p, tw, th))
    return images, tasks, skipped, bucket_counts


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("in_dir")
    p.add_argument("out_dir")
    p.add_argument("--buckets", default="512x768", metavar="MINxMAX",
                   help="bucket profile as SIDE_MINxSIDE_MAX (default 512x768; "
                        "e.g. 1024x1536 for SDXL-scale)")
    p.add_argument("--threads", type=int, default=4)
    p.add_argument("--model-path", type=Path, default=DEFAULT_MODEL_PATH)
    args = p.parse_args()

    try:
        side_min, side_max = split_buckets_arg(args.buckets)
    except ValueError as e:
        p.error(str(e))

    import cv2

    in_dir, out_dir = Path(args.in_dir), Path(args.out_dir)
    if not in_dir.is_dir():
        sys.exit(f"input folder not found: {in_dir}")
    if out_dir.resolve() == in_dir.resolve():
        sys.exit("out_dir must differ from in_dir (this tool is non-destructive)")
    out_dir.mkdir(parents=True, exist_ok=True)

    buckets = get_valid_buckets(side_min, side_max)
    print(f"buckets ({len(buckets)}): {buckets}")

    images, tasks, skipped, bucket_counts = plan_tasks(in_dir, out_dir, buckets)
    if not images:
        sys.exit("no images found")

    if not tasks:
        print(f"all {skipped} images already bucketed in {out_dir}")
        return

    cropper = SmartCropper(ensure_model(args.model_path))
    print(f"model loaded on: {cropper.load_model()}")
    print(f"processing {len(tasks)} images ({skipped} already done), "
          f"{args.threads} threads…")

    done = 0
    errors = []
    lock = threading.Lock()

    def work(task):
        nonlocal done
        in_p, out_p, tw, th = task
        try:
            img = cv2.imread(str(in_p))
            if img is None:
                return f"{rel_label(in_p, in_dir)}: cv2 could not read"
            res = cropper.process_image(img, tw, th)
            out_p.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(out_p), res, [cv2.IMWRITE_PNG_COMPRESSION, 4])
            cap = in_p.with_suffix(".txt")
            if cap.exists():
                shutil.copy2(cap, out_p.with_suffix(".txt"))
            with lock:
                done += 1
                bucket_counts[(tw, th)] = bucket_counts.get((tw, th), 0) + 1
                if done % 10 == 0 or done == len(tasks):
                    print(f"  {done}/{len(tasks)}")
            return None
        except Exception as e:
            return f"{rel_label(in_p, in_dir)}: {e}"

    with ThreadPoolExecutor(max_workers=args.threads) as ex:
        for fut in as_completed([ex.submit(work, t) for t in tasks]):
            err = fut.result()
            if err:
                errors.append(err)
                print(f"  WARN {err}")

    print("\nbucket distribution:")
    total = 0
    for bkt in sorted(bucket_counts, key=lambda x: x[0] * x[1]):
        total += bucket_counts[bkt]
        print(f"  {bkt[0]}x{bkt[1]}: {bucket_counts[bkt]}")
    print(f"  total: {total} ({done} new, {skipped} pre-existing, "
          f"{len(errors)} error(s))")
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
