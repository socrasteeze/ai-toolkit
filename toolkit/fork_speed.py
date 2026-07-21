# Fork-only module (socrasteeze/ai-toolkit) — speed-optimization helpers.
# Keeping the logic here means the upstream hot-loop files only need tiny,
# easy-to-reapply gated insertions. See FORK_NOTES.md ("Speed optimization").

import torch


class DeferredLossTracker:
    """Accumulates per-step loss on-device and syncs to the host only every
    `every` steps, so the CPU does not have to wait for the GPU each step.

    Between syncs, `push()` returns the last synced average — the displayed /
    logged loss therefore updates every `every` steps instead of every step.
    Training math is unaffected: only the device->host `.item()` cadence
    changes.
    """

    def __init__(self, every: int):
        self.every = max(1, int(every))
        self._sum: torch.Tensor | None = None
        self._count = 0
        self._last = 0.0

    def push(self, loss_tensor: torch.Tensor) -> float:
        loss_tensor = loss_tensor.detach()
        self._sum = loss_tensor if self._sum is None else self._sum + loss_tensor
        self._count += 1
        if self._count >= self.every:
            self._last = (self._sum / self._count).item()
            self._sum = None
            self._count = 0
        return self._last
