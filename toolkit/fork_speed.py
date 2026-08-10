# Fork-only module (socrasteeze/ai-toolkit) — speed-optimization helpers.
# Keeping the logic here means the upstream hot-loop files only need tiny,
# easy-to-reapply gated insertions. See FORK_NOTES.md ("Speed optimization").

import torch


def neutralize_nonfinite_loss(loss_tensor: torch.Tensor) -> torch.Tensor:
    """Replace a non-finite loss *value* with zero without a host sync.

    Passing all three replacements explicitly is important: ``torch.nan_to_num``
    otherwise maps positive and negative infinity to the dtype's finite extrema,
    whereas the trainer's synchronous guard drops every non-finite loss.

    This is NOT equivalent to that synchronous guard, and the difference matters.
    The guard substitutes ``torch.zeros_like(loss).requires_grad_(True)`` -- a
    fresh leaf, disconnected from everything that produced the bad number, so
    backward through it is a no-op. This function returns a node that is still
    attached to that graph. ``nan_to_num``'s own backward zeroes the gradient
    wherever its input was non-finite, but zero times an infinity already sitting
    in an upstream buffer is still NaN, so a poisoned graph can reach the
    weights. What you get here is an honest loss *reading* for free; what you do
    not get is the guard's isolation. Only the sync-free path (``loss_sync_every
    > 1``) uses it, and that is the trade being made: skipping a per-accumulation
    CUDA sync in exchange for not detecting the poisoning until the next sync.
    """

    return torch.nan_to_num(
        loss_tensor,
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    )


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
