'use client';
// Fork-only component (see FORK_NOTES.md). Inline guidance under the Optimizer select
// on the new-job form, shown only when an Automagic-family optimizer is selected —
// these optimizers reinterpret the surrounding fields (LR becomes a launch point, no
// scheduler is needed, weight decay defaults differ) and their most important knobs
// (optimizer_params.min_lr/max_lr) have no UI field anywhere, so without this hint the
// form silently misleads. Guidance sourced from the optimizer author's own docstrings
// (toolkit/optimizers/automagic3.py) — see PLAN.md's Automagic v3 research entry.

import { JobConfig } from '@/types';

type Props = {
  jobConfig: JobConfig;
  setJobConfig: (value: any, key: string) => void;
};

export default function OptimizerHint({ jobConfig, setJobConfig }: Props) {
  const train = jobConfig.config.process[0].train;
  const optimizer = (train.optimizer || '').toLowerCase();
  if (!optimizer.startsWith('automagic')) return null;

  if (optimizer === 'automagic' || optimizer === 'automagic2') {
    return (
      <div className="text-xs text-gray-400 pt-1">
        {optimizer === 'automagic'
          ? 'Automagic v1 (legacy): self-adjusting per-tensor LR; forces LR to 1e-6 if set above 1e-3. Superseded by v3.'
          : 'Automagic v2: known runaway-LR behavior on long runs (static per-tensor LR, no equilibrium). Superseded by v3.'}{' '}
        <button
          type="button"
          className="text-blue-400 hover:text-blue-300 underline"
          onClick={() => setJobConfig('automagic3', 'config.process[0].train.optimizer')}
        >
          Switch to v3
        </button>
      </div>
    );
  }

  // automagic3
  const params = (train.optimizer_params || {}) as { [key: string]: any };
  const lr = train.lr;
  const boundsSet = params.min_lr !== undefined && params.max_lr !== undefined;

  return (
    <div className="text-xs text-gray-400 pt-1">
      <div>
        Automagic v3 self-adapts one LR per group — the LR above is a launch point, not a target (author default 1e-6),
        and no LR scheduler is needed. Weight decay is decoupled (optimizer default 0).
      </div>
      <div className="pt-0.5">
        {boundsSet ? (
          <span className="text-green-400">
            ✓ LR bounded: {String(params.min_lr)} – {String(params.max_lr)}
          </span>
        ) : (
          <>
            <span className="text-orange-400">Unbounded:</span> default min/max LR are only overflow guards — the
            controller can run far above your LR.{' '}
            <button
              type="button"
              className="text-blue-400 hover:text-blue-300 underline"
              title={`Sets optimizer_params.min_lr = 1e-6 and max_lr = ${lr} (your current LR becomes the ceiling; the controller can only adapt downward)`}
              onClick={() => {
                setJobConfig(0.000001, 'config.process[0].train.optimizer_params.min_lr');
                setJobConfig(lr, 'config.process[0].train.optimizer_params.max_lr');
              }}
            >
              Bound it (min 1e-6 · max = LR)
            </button>
          </>
        )}
      </div>
    </div>
  );
}
