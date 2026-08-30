"""Contract test for the shipped presets (presets/*.json).

PLAN.md recorded "all N presets parse through TrainConfig" and "accepted by the
Automagic/accumulation guard" as one-off manual checks (17 -> 21 -> 27 presets);
nothing re-ran them, so an upstream config-schema change would break a preset at
job launch instead of at merge time. This pins:

- every preset's train/datasets/model/network blocks construct through
  toolkit.config_modules (TrainConfig executes the Automagic fused+accumulation
  guard, so a preset that trips it fails here);
- every preset's arch exists in the UI's model registry
  (ui/src/app/jobs/new/options.tsx), and its `name_or_path` is not the registry
  default of a DIFFERENT arch — the check that would have caught the Z-Image
  presets pairing Turbo weights with the base `zimage` arch (tracker AIO.1,
  2026-08-29). Pointing an arch at a non-registry checkpoint is deliberate and
  allowed: that is exactly what the Illustrious/Pony presets do on `sdxl`, and
  how the advisor detects them (stepSuggestion.ts::illustriousOrPonyRecipe);
- effective batch never exceeds 4 (the advisor's ladder, PLAN.md 2026-08-24).

Run from the repo root with the .venv:
    python testing/test_presets.py
"""

import glob
import json
import os
import re
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
os.environ.setdefault("PYTHONWARNINGS", "ignore")

from toolkit.config_modules import (  # noqa: E402
    DatasetConfig,
    ModelConfig,
    NetworkConfig,
    TrainConfig,
)

PRESETS = sorted(glob.glob(str(REPO_ROOT / "presets" / "*.json")))
OPTIONS_TSX = REPO_ROOT / "ui" / "src" / "app" / "jobs" / "new" / "options.tsx"


def load_preset(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["config"]["process"][0]


def registry_name_or_path_defaults():
    """arch -> set of name_or_path values options.tsx sets when that arch is selected.

    Parsed textually: each entry is `name: '<arch>'` followed (before the next
    `name:`) by a `'config.process[0].model.name_or_path': ['<repo>', ...]` default.
    A `customModelSelectOptions` list adds further allowed repos for that arch.
    """
    text = OPTIONS_TSX.read_text(encoding="utf-8")
    entries = re.split(r"\n\s*name: '", text)[1:]
    defaults = {}
    for entry in entries:
        arch = entry.split("'", 1)[0]
        allowed = set()
        m = re.search(r"model\.name_or_path':\s*\[\s*'([^']+)'", entry)
        if m:
            allowed.add(m.group(1))
        for opt in re.findall(r"nameOrPath:\s*'([^']+)'", entry):
            allowed.add(opt)
        if allowed:
            defaults[arch] = allowed
    return defaults


class PresetContractTests(unittest.TestCase):
    def test_presets_exist(self):
        self.assertGreater(len(PRESETS), 0)

    def test_every_preset_parses_and_passes_the_config_guards(self):
        for path in PRESETS:
            with self.subTest(preset=os.path.basename(path)):
                proc = load_preset(path)
                TrainConfig(**proc["train"])
                for ds in proc["datasets"]:
                    DatasetConfig(**ds)
                ModelConfig(**proc["model"])
                NetworkConfig(**proc["network"])

    def test_effective_batch_is_within_the_advisor_ladder(self):
        for path in PRESETS:
            with self.subTest(preset=os.path.basename(path)):
                train = load_preset(path)["train"]
                effective = int(train.get("batch_size", 1)) * int(train.get("gradient_accumulation", 1))
                self.assertLessEqual(effective, 4)

    def test_preset_arch_exists_in_the_ui_model_registry(self):
        defaults = registry_name_or_path_defaults()
        self.assertIn("zimage:turbo", defaults, "options.tsx parse failed to find zimage:turbo")
        for path in PRESETS:
            with self.subTest(preset=os.path.basename(path)):
                arch = load_preset(path)["model"]["arch"]
                self.assertIn(arch, defaults, f"arch {arch!r} is not in options.tsx")

    def test_preset_weights_are_not_another_archs_registry_default(self):
        """The AIO.1 shape: Turbo weights declared under the base `zimage` arch.

        A repo that options.tsx ties to exactly one arch must only appear under that
        arch. A repo no arch claims (an Illustrious/Pony checkpoint on `sdxl`) is a
        deliberate family override and is left alone.
        """
        defaults = registry_name_or_path_defaults()
        owners = {}
        for arch, repos in defaults.items():
            for repo in repos:
                owners.setdefault(repo, set()).add(arch)
        for path in PRESETS:
            with self.subTest(preset=os.path.basename(path)):
                model = load_preset(path)["model"]
                arch, repo = model["arch"], model["name_or_path"]
                claimed_by = owners.get(repo)
                if not claimed_by:
                    continue  # not a registry model at all — a family override
                self.assertIn(
                    arch,
                    claimed_by,
                    f"{repo!r} is the registry default for {sorted(claimed_by)}, not for arch {arch!r}",
                )

    def test_turbo_arch_presets_carry_the_training_adapter(self):
        # zimage:turbo's whole point is the assistant LoRA; a preset that drops it trains
        # the distilled weights directly (the AIO.1 bug).
        for path in PRESETS:
            model = load_preset(path)["model"]
            if model["arch"] == "zimage:turbo":
                with self.subTest(preset=os.path.basename(path)):
                    self.assertTrue(model.get("assistant_lora_path"))


if __name__ == "__main__":
    unittest.main()
