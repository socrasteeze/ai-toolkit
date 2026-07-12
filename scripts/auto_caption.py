"""WD14 auto-captioning CLI (spec Workstream B2, ported from Anima-TrainFlow).

Usage:
    python scripts/auto_caption.py <dataset_dir> [--general-thresh 0.35]
        [--char-thresh 0.85] [--trigger-word WORD] [--overwrite] [--threads 4]

Tags every image in <dataset_dir> with SmilingWolf's wd-eva02-large-tagger-v3
(ONNX) and writes a comma-separated tag list to the image's .txt sidecar.
Existing captions are skipped unless --overwrite. Model weights (~3 GB) are
pulled from HuggingFace on first run and cached in the standard HF cache.

Runs on GPU when onnxruntime's CUDA provider can initialize, else CPU.
Tag assembly matches TrainFlow/WDTagger exactly: character tags (category 4)
first, then general tags (category 0) sorted by confidence, "_"→" " except
kaomoji, parentheses escaped. --trigger-word is prepended as the first tag.
"""

import argparse
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np

def add_torch_cuda_dlls():
    """Let onnxruntime's CUDA provider find the CUDA/cuDNN DLLs bundled with
    the torch wheel (they aren't on PATH on Windows)."""
    import os
    try:
        import torch
        lib = Path(torch.__file__).parent / "lib"
        if lib.is_dir() and hasattr(os, "add_dll_directory"):
            os.add_dll_directory(str(lib))
    except ImportError:
        pass


HF_REPO = "SmilingWolf/wd-eva02-large-tagger-v3"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
TARGET_SIZE = 448
KAOMOJIS = ["0_0", "(o)_(o)", "+_+", "+_-", "._.", "<o>_<o>", "<|>_<|>", "=_=",
            ">_<", "3_3", "6_9", ">_o", "@_@", "^_^", "o_o", "u_u", "x_x",
            "|_|", "||_||"]


class WDTagger:
    def __init__(self):
        self.model = None
        self.tag_names = []
        self.general_indexes = []
        self.character_indexes = []

    def load_model(self) -> str:
        import csv
        add_torch_cuda_dlls()
        import onnxruntime as rt
        from huggingface_hub import hf_hub_download

        model_path = hf_hub_download(HF_REPO, "model.onnx")
        csv_path = hf_hub_download(HF_REPO, "selected_tags.csv")

        with open(csv_path, newline="", encoding="utf-8") as f:
            for i, row in enumerate(csv.DictReader(f)):
                name = row["name"]
                if name not in KAOMOJIS:
                    name = name.replace("_", " ")
                self.tag_names.append(name)
                if row["category"] == "0":
                    self.general_indexes.append(i)
                elif row["category"] == "4":
                    self.character_indexes.append(i)

        providers = [
            ("CUDAExecutionProvider", {
                "device_id": 0,
                "arena_extend_strategy": "kNextPowerOfTwo",
                "cudnn_conv_algo_search": "EXHAUSTIVE",
                "do_copy_in_default_stream": True,
            }),
            "CPUExecutionProvider",
        ]
        self.model = rt.InferenceSession(model_path, providers=providers)
        return "GPU (CUDA)" if "CUDA" in self.model.get_providers()[0] else "CPU"

    def preprocess(self, image):
        from PIL import Image
        canvas = Image.new("RGBA", image.size, (255, 255, 255))
        canvas.alpha_composite(image.convert("RGBA"))
        image = canvas.convert("RGB")
        max_dim = max(image.size)
        pad_left = (max_dim - image.size[0]) // 2
        pad_top = (max_dim - image.size[1]) // 2
        padded = Image.new("RGB", (max_dim, max_dim), (255, 255, 255))
        padded.paste(image, (pad_left, pad_top))
        if max_dim != TARGET_SIZE:
            padded = padded.resize((TARGET_SIZE, TARGET_SIZE), Image.BICUBIC)
        arr = np.asarray(padded, dtype=np.float32)
        arr = arr[:, :, ::-1]  # RGB -> BGR
        return np.expand_dims(arr, axis=0)

    def predict(self, image, gen_thresh: float, char_thresh: float) -> str:
        arr = self.preprocess(image)
        input_name = self.model.get_inputs()[0].name
        preds = self.model.run(None, {input_name: arr})[0][0]

        general = [self.tag_names[i] for i in self.general_indexes
                   if i < len(preds) and preds[i] > gen_thresh]
        chars = [self.tag_names[i] for i in self.character_indexes
                 if i < len(preds) and preds[i] > char_thresh]

        chars = [c.replace("(", r"\(").replace(")", r"\)") for c in chars]
        general = sorted(general,
                         key=lambda x: preds[self.tag_names.index(x)],
                         reverse=True)

        parts = []
        if chars:
            parts.append(", ".join(chars))
        if general:
            parts.append(", ".join(general).replace("(", r"\(").replace(")", r"\)"))
        return ", ".join(parts)


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("dataset_dir")
    p.add_argument("--general-thresh", type=float, default=0.35)
    p.add_argument("--char-thresh", type=float, default=0.85)
    p.add_argument("--trigger-word", default=None,
                   help="prepended as the first tag of every caption")
    p.add_argument("--overwrite", action="store_true",
                   help="re-caption images that already have a .txt sidecar")
    p.add_argument("--threads", type=int, default=4)
    args = p.parse_args()

    from PIL import Image

    folder = Path(args.dataset_dir)
    if not folder.is_dir():
        sys.exit(f"dataset folder not found: {folder}")

    all_images = [f for f in sorted(folder.iterdir())
                  if f.is_file() and f.suffix.lower() in IMAGE_EXTS]
    todo = [f for f in all_images
            if args.overwrite or not f.with_suffix(".txt").exists()]
    skipped = len(all_images) - len(todo)

    if not all_images:
        sys.exit("no images found")
    if not todo:
        print(f"all {skipped} images already captioned (use --overwrite to redo)")
        return

    tagger = WDTagger()
    print("loading wd-eva02-large-tagger-v3 (downloads ~3 GB on first run)…")
    print(f"model loaded on: {tagger.load_model()}")
    print(f"tagging {len(todo)} images ({skipped} skipped), "
          f"{args.threads} threads…")

    done = 0
    errors = []
    lock = threading.Lock()

    def work(img_path: Path):
        nonlocal done
        try:
            with Image.open(img_path) as img:
                tags = tagger.predict(img, args.general_thresh, args.char_thresh)
            if args.trigger_word:
                tags = f"{args.trigger_word}, {tags}" if tags else args.trigger_word
            img_path.with_suffix(".txt").write_text(tags, encoding="utf-8")
            with lock:
                done += 1
                if done % 10 == 0 or done == len(todo):
                    print(f"  {done}/{len(todo)}")
            return None
        except Exception as e:
            return f"{img_path.name}: {e}"

    with ThreadPoolExecutor(max_workers=args.threads) as ex:
        for fut in as_completed([ex.submit(work, f) for f in todo]):
            err = fut.result()
            if err:
                errors.append(err)
                print(f"  WARN {err}")

    print(f"done: {done} captioned, {skipped} skipped, {len(errors)} error(s)")
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
