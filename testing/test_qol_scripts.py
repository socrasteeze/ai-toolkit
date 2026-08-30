"""CPU-only regressions for the fork's QoL dataset CLIs (scripts/preflight.py,
scripts/auto_caption.py, scripts/smart_prep.py) and their shared helper
(scripts/qol_common.py).

The headline case is dataset discovery: until 2026-08-29 all three scripts
scanned a flat folder while the trainer walks subfolders, so a nested dataset
made pre-flight fail with "no images found" and the other two tools silently
process nothing. Discovery now delegates to toolkit/dataset_selection.py; these
tests pin that the scripts see exactly what the trainer sees.

Run from the repo root with the .venv (needs Pillow, numpy):
    python testing/test_qol_scripts.py
"""

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
for entry in (REPO_ROOT, REPO_ROOT / "scripts"):
    if str(entry) not in sys.path:
        sys.path.insert(0, str(entry))

import qol_common  # noqa: E402
import preflight  # noqa: E402
import auto_caption  # noqa: E402
import smart_prep  # noqa: E402


def write_png(path: Path, size=(64, 64)):
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, (128, 128, 128)).save(path)


def write_text(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class NestedDatasetMixin:
    """A dataset shaped like the ones DatasetFolderPickerModal produces."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        write_png(self.root / "loose.png")
        write_text(self.root / "loose.txt", "a caption")
        write_png(self.root / "Folder A" / "a.jpg")
        write_text(self.root / "Folder A" / "a.txt", "a caption")
        write_png(self.root / "Folder A" / "Nested" / "deep.png")  # no caption
        write_png(self.root / "Folder B" / "b.webp")
        write_text(self.root / "Folder B" / "b.txt", "   ")  # empty caption
        write_text(self.root / "Folder B" / "notes.md", "stray")
        # things the trainer never reads
        write_png(self.root / ".thumbs" / "thumb.png")
        write_png(self.root / "_controls" / "control.png")
        write_text(self.root / "_latent_cache" / "x.safetensors", "bin")
        write_text(self.root / ".aitk_size.json", "{}")

    def tearDown(self):
        self.temp_dir.cleanup()

    def rel(self, paths):
        return sorted(qol_common.rel_label(p, self.root) for p in paths)


class QolCommonTests(NestedDatasetMixin, unittest.TestCase):
    def test_list_images_matches_the_trainer_walk(self):
        self.assertEqual(
            self.rel(qol_common.list_images(self.root, {".png", ".jpg", ".webp"})),
            ["Folder A/Nested/deep.png", "Folder A/a.jpg", "Folder B/b.webp", "loose.png"],
        )

    def test_list_images_honours_child_folder_scope(self):
        only_b = qol_common.list_images(
            self.root, {".png", ".jpg", ".webp"},
            include_loose_files=False, include_subfolders=["Folder B"],
        )
        self.assertEqual(self.rel(only_b), ["Folder B/b.webp"])

    def test_walk_prunes_hidden_control_and_cache_folders(self):
        seen = self.rel(qol_common.walk_dataset_files(self.root))
        self.assertIn("Folder B/notes.md", seen)
        self.assertNotIn(".thumbs/thumb.png", seen)
        self.assertNotIn("_controls/control.png", seen)
        self.assertNotIn("_latent_cache/x.safetensors", seen)
        self.assertNotIn(".aitk_size.json", seen)

    def test_split_buckets_arg(self):
        self.assertEqual(qol_common.split_buckets_arg("512x768"), (512, 768))
        self.assertEqual(qol_common.split_buckets_arg("1024X1024"), (1024, 1024))
        for bad in ("512", "500x700", "768x512", "axb"):
            with self.assertRaises(ValueError):
                qol_common.split_buckets_arg(bad)


class PreflightTests(NestedDatasetMixin, unittest.TestCase):
    def run_check(self, allow_missing=False, warn_only=False, caption_ext="txt"):
        report = preflight.Report(warn_only)
        with contextlib.redirect_stdout(io.StringIO()) as out:
            preflight.check_dataset(self.root, caption_ext, 2048, allow_missing, report)
        return report, out.getvalue()

    def test_nested_dataset_is_counted_in_full(self):
        report, out = self.run_check()
        self.assertIn("4 images", out)

    def test_missing_caption_is_reported_with_its_subpath(self):
        report, _ = self.run_check()
        self.assertEqual(len(report.errors), 1)
        self.assertIn("Folder A/Nested/deep.png", report.errors[0])

    def test_empty_caption_and_stray_file_are_warnings(self):
        report, _ = self.run_check(allow_missing=True)
        self.assertEqual(report.errors, [])
        joined = "\n".join(report.warnings)
        self.assertIn("1 empty caption file", joined)
        self.assertIn("Folder B/notes.md", joined)
        # nothing from the pruned folders leaks into the stray-file list
        self.assertNotIn("_latent_cache", joined)
        self.assertNotIn("_controls", joined)

    def test_warn_only_downgrades_errors(self):
        report, _ = self.run_check(warn_only=True)
        self.assertEqual(report.errors, [])
        self.assertTrue(any("missing .txt captions" in w for w in report.warnings))

    def test_print_and_exit_codes(self):
        report = preflight.Report(False)
        report.warn("w")
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as ok:
                report.print_and_exit()
        self.assertEqual(ok.exception.code, 0)
        report.error("e")
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as failed:
                report.print_and_exit()
        self.assertEqual(failed.exception.code, 1)

    def test_empty_folder_is_an_error(self):
        with tempfile.TemporaryDirectory() as empty:
            report = preflight.Report(False)
            with contextlib.redirect_stdout(io.StringIO()):
                preflight.check_dataset(Path(empty), "txt", 2048, False, report)
            self.assertEqual(len(report.errors), 1)
            self.assertIn("no images found", report.errors[0])

    def test_looks_like_local_path(self):
        for repo_id in ("Tongyi-MAI/Z-Image-Turbo", "ostris/anima"):
            self.assertFalse(preflight.looks_like_local_path(repo_id), repo_id)
        for local in (
            "C:\\models\\x.safetensors", "D:/models/x", "/mnt/models/x",
            "./x", "~/x", "models/sub/x", "x.safetensors", "x.gguf",
        ):
            self.assertTrue(preflight.looks_like_local_path(local), local)


class AutoCaptionTests(NestedDatasetMixin, unittest.TestCase):
    def test_collect_images_walks_subfolders_and_skips_captioned(self):
        all_images, todo = auto_caption.collect_images(self.root, overwrite=False)
        self.assertEqual(
            self.rel(all_images),
            ["Folder A/Nested/deep.png", "Folder A/a.jpg", "Folder B/b.webp", "loose.png"],
        )
        # b.webp has an (empty) sidecar, so only the uncaptioned nested image is due
        self.assertEqual(self.rel(todo), ["Folder A/Nested/deep.png"])

    def test_overwrite_recaptions_everything(self):
        all_images, todo = auto_caption.collect_images(self.root, overwrite=True)
        self.assertEqual(len(todo), len(all_images))


class SmartPrepTests(NestedDatasetMixin, unittest.TestCase):
    def test_plan_preserves_subfolder_layout(self):
        out_dir = self.root.parent / (self.root.name + "_prepped")
        buckets = smart_prep.get_valid_buckets(512, 768)
        with contextlib.redirect_stdout(io.StringIO()):
            images, tasks, skipped, counts = smart_prep.plan_tasks(self.root, out_dir, buckets)
        self.assertEqual(len(images), 4)
        self.assertEqual(skipped, 0)
        destinations = sorted(
            qol_common.rel_label(dst, out_dir) for (_src, dst, _w, _h) in tasks
        )
        self.assertEqual(
            destinations,
            ["Folder A/Nested/deep.png", "Folder A/a.png", "Folder B/b.png", "loose.png"],
        )
        for (_src, _dst, w, h) in tasks:
            self.assertIn((w, h), buckets)

    def test_plan_resumes_over_existing_outputs_at_bucket_size(self):
        out_dir = self.root.parent / (self.root.name + "_prepped")
        buckets = smart_prep.get_valid_buckets(512, 768)
        # a 64x64 source maps to the square bucket; pre-create that output
        write_png(out_dir / "loose.png", size=(512, 512))
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                _images, tasks, skipped, counts = smart_prep.plan_tasks(self.root, out_dir, buckets)
            self.assertEqual(skipped, 1)
            self.assertEqual(counts[(512, 512)], 1)
            self.assertNotIn("loose.png", [dst.name for (_s, dst, _w, _h) in tasks])
        finally:
            import shutil
            shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
