import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from jobs.process.BaseSDTrainProcess import BaseSDTrainProcess


class LatestSavePathTest(unittest.TestCase):
    def _latest(self, names, dirs=()):
        """names and dirs are oldest to newest; each entry gets a later creation time."""
        with tempfile.TemporaryDirectory() as root:
            order = {}
            for n, name in enumerate([*names, *dirs]):
                path = os.path.join(root, name)
                if name in dirs:
                    os.mkdir(path)
                else:
                    open(path, 'w').close()
                order[path] = n
            process = SimpleNamespace(job=SimpleNamespace(name='run'), save_root=root, network_config=None)
            with mock.patch('os.path.getctime', side_effect=order.__getitem__):
                latest = BaseSDTrainProcess.get_latest_save_path(process, include_pretrained_lora=False)
            return latest and os.path.basename(latest)

    def test_newer_sidecar_is_ignored(self):
        self.assertEqual(
            self._latest(['run_000000100.safetensors', 'run.safetensors', 'run.swarm.json']),
            'run.safetensors',
        )

    def test_only_sidecars_means_nothing_to_resume(self):
        self.assertIsNone(self._latest(['run.swarm.json']))

    def test_pt_saves_still_resume(self):
        self.assertEqual(self._latest(['run_000000100.safetensors', 'run_000000200.pt']), 'run_000000200.pt')

    def test_diffusers_folder_saves_still_resume(self):
        self.assertEqual(self._latest(['run_000000100.safetensors'], dirs=['run_000000200']), 'run_000000200')


if __name__ == '__main__':
    unittest.main()
