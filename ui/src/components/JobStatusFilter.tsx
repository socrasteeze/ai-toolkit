// fork addition, see FORK_NOTES.md
import { useEffect, useState } from 'react';
import classNames from 'classnames';

const STORAGE_KEY = 'aitk_jobs_status_filter';
const OPTIONS = [
  { value: '', label: 'All' },
  ...['queued', 'running', 'stopping', 'completed', 'stopped', 'error'].map(value => ({ value, label: value })),
];

export function useJobStatusFilter() {
  const [statusFilter, setStatusFilter] = useState('');

  // read after mount: the server render has no localStorage
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && OPTIONS.some(option => option.value === saved)) setStatusFilter(saved);
  }, []);

  const chooseStatusFilter = (value: string) => {
    setStatusFilter(value);
    localStorage.setItem(STORAGE_KEY, value);
  };

  return [statusFilter, chooseStatusFilter] as const;
}

export default function JobStatusFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    // wraps instead of scrolling so the saved filter is never off-screen on a phone
    <div className="mb-3 flex flex-wrap gap-1">
      {OPTIONS.map(option => (
        <button
          key={option.value}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={classNames(
            'rounded-md px-3 py-2 text-sm capitalize sm:py-1',
            option.value === value ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
