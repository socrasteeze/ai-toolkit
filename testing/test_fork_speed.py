import math
import unittest

import torch

from toolkit.fork_speed import DeferredLossTracker, neutralize_nonfinite_loss


class NeutralizeNonfiniteLossTest(unittest.TestCase):
    def test_nonfinite_scalars_become_zero(self):
        for value in (math.nan, math.inf, -math.inf):
            with self.subTest(value=value):
                loss = torch.tensor(value, dtype=torch.float32, requires_grad=True)

                neutralized = neutralize_nonfinite_loss(loss)

                self.assertEqual(neutralized.item(), 0.0)
                self.assertEqual(neutralized.dtype, loss.dtype)
                self.assertEqual(neutralized.device, loss.device)
                neutralized.backward()
                self.assertEqual(loss.grad.item(), 0.0)

    def test_result_stays_attached_to_the_graph(self):
        # Documents the deliberate gap with the synchronous isfinite branch in
        # SDTrainer, which substitutes a detached leaf. Here the node keeps its
        # history, so upstream NaNs are neutralized in the reading only.
        loss = (torch.tensor(math.nan, dtype=torch.float32, requires_grad=True) * 2.0)

        neutralized = neutralize_nonfinite_loss(loss)

        self.assertIsNotNone(neutralized.grad_fn)
        self.assertTrue(neutralized.requires_grad)

        detached_like_the_sync_branch = torch.zeros_like(loss).requires_grad_(True)
        self.assertIsNone(detached_like_the_sync_branch.grad_fn)

    def test_finite_scalar_and_gradient_are_preserved(self):
        loss = torch.tensor(-3.25, dtype=torch.float64, requires_grad=True)

        neutralized = neutralize_nonfinite_loss(loss)

        self.assertEqual(neutralized.item(), loss.item())
        self.assertEqual(neutralized.dtype, loss.dtype)
        neutralized.backward()
        self.assertEqual(loss.grad.item(), 1.0)


class DeferredLossTrackerTest(unittest.TestCase):
    def test_syncs_average_at_requested_cadence(self):
        tracker = DeferredLossTracker(every=3)

        self.assertEqual(tracker.push(torch.tensor(1.0)), 0.0)
        self.assertEqual(tracker.push(torch.tensor(2.0)), 0.0)
        self.assertEqual(tracker.push(torch.tensor(3.0)), 2.0)
        self.assertEqual(tracker.push(torch.tensor(4.0)), 2.0)
        self.assertEqual(tracker.push(torch.tensor(5.0)), 2.0)
        self.assertEqual(tracker.push(torch.tensor(6.0)), 5.0)

    def test_detaches_pending_loss(self):
        tracker = DeferredLossTracker(every=2)
        loss = torch.tensor(7.0, requires_grad=True)

        self.assertEqual(tracker.push(loss), 0.0)
        self.assertIsNotNone(tracker._sum)
        self.assertFalse(tracker._sum.requires_grad)
        self.assertIsNone(tracker._sum.grad_fn)
        self.assertIsNone(loss.grad)

    def test_clamps_invalid_cadence_to_one(self):
        tracker = DeferredLossTracker(every=0)

        self.assertEqual(tracker.push(torch.tensor(7.0)), 7.0)
        self.assertIsNone(tracker._sum)


if __name__ == "__main__":
    unittest.main()
