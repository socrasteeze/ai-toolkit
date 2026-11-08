// fork addition, see FORK_NOTES.md
import { useEffect, useState } from 'react';
import { SelectInput } from '@/components/formInputs';

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
  return <SelectInput className="mb-4 w-48" label="Status" value={value} onChange={onChange} options={OPTIONS} />;
}
