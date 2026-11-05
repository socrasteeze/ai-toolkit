'use client';

import type { PerformancePlan } from '@/utils/performanceAdvisor';

type Props = {
  plan: PerformancePlan | null;
  setJobConfig: (value: any, path: string) => void;
};

export default function PerformanceAdvisor({ plan, setJobConfig }: Props) {
  if (!plan) return null;
  return (
    <details className="mt-2 rounded border border-gray-700 p-2 text-xs text-gray-400">
      <summary className="cursor-pointer text-gray-300">5090 Performance</summary>
      <div className="mt-2 space-y-2">
        <div className="text-gray-300">{plan.model} · Automagic v4</div>
        <div>{plan.context}</div>
        {plan.gpu && plan.freeMiB !== null && (
          <div>
            GPU {plan.gpu.index} · {(plan.freeMiB / 1024).toFixed(1)} GiB free of{' '}
            {(plan.gpu.memory.total / 1024).toFixed(1)} GiB
          </div>
        )}
        <p>{plan.notice}</p>
        {plan.rows.length > 0 && (
          <>
            <ul className="divide-y divide-gray-800">
              {plan.rows.map(row => (
                <li key={row.id} className="py-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-gray-300">{row.label}</span>
                    <span className={row.status === 'Enabled' ? 'text-green-400' : 'text-amber-400'}>{row.status}</span>
                    {row.changes.length > 0 && (
                      <button
                        type="button"
                        className="text-blue-400 underline hover:text-blue-300"
                        aria-label={`Apply ${row.label}`}
                        onClick={() => row.changes.forEach(change => setJobConfig(change.value, change.path))}
                      >
                        Apply
                      </button>
                    )}
                  </div>
                  <p className="mt-1">{row.detail}</p>
                </li>
              ))}
            </ul>
            <p>The cache buttons preserve the optimizer, learning rate, rank, batch size, accumulation and steps.</p>
          </>
        )}
      </div>
    </details>
  );
}
