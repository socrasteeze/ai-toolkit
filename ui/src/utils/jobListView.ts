// fork addition, see FORK_NOTES.md
export type JobNameSort = 'default' | 'asc' | 'desc';

export function nextJobNameSort(sort: JobNameSort): JobNameSort {
  return sort === 'default' ? 'asc' : sort === 'asc' ? 'desc' : 'default';
}

export function matchesJobSearch(job: { name: string }, search: string): boolean {
  return job.name.toLocaleLowerCase().includes(search.toLocaleLowerCase());
}

// Input is already in the section's default order. Keep that order for equal names.
export function sortJobsByName<T extends { name: string }>(jobs: T[], sort: JobNameSort): T[] {
  if (sort === 'default') return jobs;
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  return [...jobs].sort((a, b) => collator.compare(a.name, b.name) * (sort === 'asc' ? 1 : -1));
}
