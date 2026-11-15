// fork addition, see FORK_NOTES.md
import { useEffect, useState } from 'react';
import { JobNameSort, nextJobNameSort } from '@/utils/jobListView';

const STORAGE_KEY = 'aitk_jobs_name_sort';

export default function useJobNameSort() {
  const [nameSort, setNameSort] = useState<JobNameSort>('default');

  // Read after mount so the server and first client render use the same order.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'default' || saved === 'asc' || saved === 'desc') setNameSort(saved);
    } catch {
      // Sorting still works when browser storage is unavailable.
    }
  }, []);

  const cycleNameSort = () => {
    const next = nextJobNameSort(nameSort);
    setNameSort(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Keep the choice for this mount when browser storage is unavailable.
    }
  };

  return [nameSort, cycleNameSort] as const;
}
