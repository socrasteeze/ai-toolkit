"""Contract test for the shipped presets (presets/*.json).

PLAN.md recorded "all N presets parse through TrainConfig" and "accepted by the
Automagic/accumulation guard" as one-off manual checks (17 -> 21 -> 27 presets);
nothing re-ran them, so an upstream config-schema change would break a preset at
job launch instead of at merge time. This pins:

- every preset's train/datasets/model/network blocks construct through
  toolkit.config_modules (TrainConfig executes the Automagic fused+accumulation
  guard, so a preset that trips it fails here);
- every preset's arch exists in the UI's model registry (extension ui.tsx files
  under extensions_built_in/ and extensions/, loaded at runtime by
  ui/src/extensions/modelArchs.ts since the 2026-09-20 upstream move out of
  options.tsx), and its `name_or_path` is not the registry default of a
  DIFFERENT arch — the check that would have caught the Z-Image presets
  pairing Turbo weights with the base `zimage` arch (tracker AIO.1,
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
# Per-plugin UI model cards (AI_TOOLKIT_UI_MODELS). options.tsx no longer holds
# the static modelArchs array after upstream's 2026-09-20 move.
UI_MODEL_GLOBS = [
    str(REPO_ROOT / "extensions_built_in" / "*" / "ui.tsx"),
    str(REPO_ROOT / "extensions_built_in" / "*" / "ui.ts"),
    str(REPO_ROOT / "extensions" / "*" / "ui.tsx"),
    str(REPO_ROOT / "extensions" / "*" / "ui.ts"),
]


def load_preset(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["config"]["process"][0]


def _arch_defaults_from_text(text):
    """arch -> set of name_or_path values a UI model card sets when selected.

    Parsed textually across single- or double-quoted TS/JS. Each entry is
    `name: '<arch>'` / `name: "<arch>"` followed (before the next `name:`) by a
    `model.name_or_path': ['<repo>', ...]` (or double-quoted) default.
    A `customModelSelectOptions` / `nameOrPath` list adds further allowed repos.
    """
    defaults = {}
    # Split on name: '...' or name: "..." at the start of a property line.
    entries = re.split(r'\n\s*name:\s*', text)[1:]
    for entry in entries:
        qm = re.match(r'(["\'])([^"\']+)\1', entry)
        if not qm:
            continue
        arch = qm.group(2)
        allowed = set()
        for m in re.finditer(
            r"model\.name_or_path['\"]?\s*:\s*\[\s*(['\"])([^'\"]+)\1",
            entry,
        ):
            allowed.add(m.group(2))
        for opt in re.findall(r"nameOrPath:\s*(['\"])([^'\"]+)\1", entry):
            allowed.add(opt[1])
        if allowed:
            # Later modules override earlier ones by arch name (modelArchs.ts).
            defaults[arch] = allowed
    return defaults


def registry_name_or_path_defaults():
    """Merge arch -> name_or_path defaults from every extension ui.tsx/.ts."""
    defaults = {}
    paths = []
    for pattern in UI_MODEL_GLOBS:
        paths.extend(glob.glob(pattern))
    for path in sorted(paths):
        text = Path(path).read_text(encoding="utf-8")
        defaults.update(_arch_defaults_from_text(text))
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
                effective = int(train.get("batch_size", 1)) * int(
                    train.get("gradient_accumulation", 1)
                )
                self.assertLessEqual(effective, 4)

    def test_preset_arch_exists_in_the_ui_model_registry(self):
        defaults = registry_name_or_path_defaults()
        self.assertIn(
            "zimage:turbo",
            defaults,
            "extension ui.tsx parse failed to find zimage:turbo",
        )
        for path in PRESETS:
            with self.subTest(preset=os.path.basename(path)):
                arch = load_preset(path)["model"]["arch"]
                self.assertIn(arch, defaults, f"arch {arch!r} is not in extension ui.tsx")

    def test_preset_weights_are_not_another_archs_registry_default(self):
        """The AIO.1 shape: Turbo weights declared under the base `zimage` arch.

        A repo that the UI registry ties to exactly one arch must only appear under
        that arch. A repo no arch claims (an Illustrious/Pony checkpoint on `sdxl`)
        is a deliberate family override and is left alone.
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
                claimed = owners.get(repo)
                if claimed is None:
                    continue
                self.assertIn(
                    arch,
                    claimed,
                    f"{os.path.basename(path)}: {repo!r} is the registry default "
                    f"for {sorted(claimed)}, not {arch!r}",
                )


if __name__ == "__main__":
    unittest.main()
