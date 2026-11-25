import { useMemo, useState } from 'react';
import useJobsList from '@/hooks/useJobsList';
import Link from 'next/link';
import UniversalTable, { TableColumn } from '@/components/UniversalTable';
import { GpuInfo } from '@/types';
import JobActionBar from './JobActionBar';
import { Job, Queue } from '@prisma/client';
import useQueueList from '@/hooks/useQueueList';
import classNames from 'classnames';
import { startQueue, stopQueue } from '@/utils/queue';
import { CgSpinner } from 'react-icons/cg';
import useGPUInfo from '@/hooks/useGPUInfo';
import { openConfirm } from '@/components/ConfirmModal';
import { deleteJob, displayJobInfo, getDisplayStep, getTotalSteps, stopJob } from '@/utils/jobs';
// fork addition, see FORK_NOTES.md
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { splitPeerGpu } from '@/utils/gpuIds';
import useCollapsedQueues from '@/hooks/useCollapsedQueues';
import JobStatusFilter, { useJobStatusFilter } from './JobStatusFilter';
import JobSearch from './JobSearch';
import useJobNameSort from '@/hooks/useJobNameSort';
import { matchesJobSearch, sortJobsByName } from '@/utils/jobListView';

interface JobsTableProps {
  autoStartQueue?: boolean;
  onlyActive?: boolean;
  job_type?: string | null;
}

function queueSummary(jobs: { status: string }[]): string {
  const counts = { running: 0, queued: 0, stopped: 0, error: 0, stopping: 0 };
  for (const job of jobs) {
    if (job.status in counts) counts[job.status as keyof typeof counts] += 1;
  }
  const parts = [
    `${counts.running} running`,
    `${counts.queued} queued`,
    `${counts.stopped} stopped`,
    `${counts.error} error`,
  ];
  if (counts.stopping > 0) parts.push(`${counts.stopping} stopping`);
  return parts.join(' · ');
}

export default function JobsTable({ onlyActive = false, job_type = null }: JobsTableProps) {
  const { jobs: allJobs, status, refreshJobs } = useJobsList({ onlyActive, reloadInterval: 5000, job_type });
  // fork addition, see FORK_NOTES.md - the status filter applies only to Idle
  const [savedStatusFilter, setSavedStatusFilter] = useJobStatusFilter();
  const statusFilter = onlyActive ? '' : savedStatusFilter;
  const [search, setSearch] = useState('');
  const [nameSort, cycleNameSort] = useJobNameSort();
  const { queues, status: queueStatus, refreshQueues } = useQueueList();
  const { gpuList, isGPUInfoLoaded } = useGPUInfo();
  const { isCollapsed, toggleQueue } = useCollapsedQueues();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteProgress, setDeleteProgress] = useState<{ done: number; total: number } | null>(null);

  const refresh = () => {
    refreshJobs();
    refreshQueues();
  };

  const jobsDict = useMemo(() => {
    if (!isGPUInfoLoaded) return {};
    // fork: allJobs, so a filter matching nothing keeps the queue START/STOP headers
    if (allJobs.length === 0) return {};
    let jd: { [key: string]: { name: string; jobs: Job[] } } = {};
    gpuList.forEach(gpu => {
      jd[`${gpu.index}`] = { name: `${gpu.name}`, jobs: [] };
    });
    jd['Idle'] = { name: 'Idle', jobs: [] };
    allJobs.forEach(job => {
      const isActive = ['queued', 'running', 'stopping'].includes(job.status);
      if (!isActive) {
        if (!statusFilter || job.status === statusFilter) jd['Idle'].jobs.push(job);
        return;
      }
      // fork addition, see FORK_NOTES.md — a job on another machine gets its own
      // group. Without this it fell through to `gpu?.index || '0'` and was listed
      // under THIS machine's GPU 0, which says the local card is busy when it is not.
      // The key is the raw `gpu_ids` because the group header below looks the
      // queue up by it (`queues.find(q => q.gpu_ids === gpuKey)`) to drive its
      // START/STOP button — and the hub really does hold a Queue row named that.
      const remote = splitPeerGpu(job.gpu_ids);
      if (remote) {
        const remoteKey = job.gpu_ids;
        if (!(remoteKey in jd)) {
          jd[remoteKey] = { name: `${remote.peerId} — GPU ${remote.localGpuIds}`, jobs: [] };
        }
        jd[remoteKey].jobs.push(job);
        return;
      }
      const gpu = gpuList.find(gpu => job.gpu_ids?.split(',').includes(gpu.index.toString())) as GpuInfo;
      const key = `${gpu?.index || '0'}`;
      if (key in jd) {
        jd[key].jobs.push(job);
      } else if (!statusFilter || job.status === statusFilter) {
        jd['Idle'].jobs.push(job);
      }
    });
    // fork addition, see FORK_NOTES.md - search after grouping to retain queue controls.
    // Remote groups still require an active job in allJobs.
    // sort the queued/running jobs by queue position
    Object.keys(jd).forEach(key => {
      jd[key].jobs = jd[key].jobs.filter(job => matchesJobSearch(job, search));
      if (key === 'Idle') {
        jd[key].jobs.sort((a, b) => {
          // sort by updated_at, newest first
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        });
      } else {
        jd[key].jobs.sort((a, b) => {
          if (a.queue_position === null) return 1;
          if (b.queue_position === null) return -1;
          return a.queue_position - b.queue_position;
        });
      }
      jd[key].jobs = sortJobsByName(jd[key].jobs, nameSort);
    });
    return jd;
  }, [allJobs, statusFilter, search, nameSort, gpuList, isGPUInfoLoaded]);

  // Bulk actions use exactly the rendered rows after search and status filtering.
  const jobs = useMemo(
    () => Object.entries(jobsDict).flatMap(([key, group]) => (onlyActive && key === 'Idle' ? [] : group.jobs)),
    [jobsDict, onlyActive],
  );

  const isDeleting = deleteProgress !== null;
  const allSelected = jobs.length > 0 && jobs.every(job => selectedIds.has(job.id));

  const toggleRow = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(jobs.map(job => job.id)));
  };

  const onMassDelete = () => {
    const jobsToDelete = jobs.filter(job => selectedIds.has(job.id));
    if (jobsToDelete.length === 0) return;
    const runningCount = jobsToDelete.filter(job => job.status === 'running').length;
    // fork: bulk delete uses the same DB-only route. Training folders stay on disk.
    let message = `Are you sure you want to delete ${jobsToDelete.length} job${
      jobsToDelete.length === 1 ? '' : 's'
    }? ${jobsToDelete.length === 1 ? 'The training folder is kept on disk.' : 'The training folders are kept on disk.'}`;
    if (runningCount > 0) {
      message += ` WARNING: ${runningCount} of them ${
        runningCount === 1 ? 'is' : 'are'
      } currently running and will be stopped first.`;
    }
    openConfirm({
      title: 'Delete Jobs',
      message: message,
      type: 'warning',
      confirmText: 'Delete',
      onConfirm: async () => {
        setDeleteProgress({ done: 0, total: jobsToDelete.length });
        for (let i = 0; i < jobsToDelete.length; i++) {
          const job = jobsToDelete[i];
          try {
            if (job.status === 'running') {
              try {
                await stopJob(job.id);
              } catch (e) {
                console.error('Error stopping job before deleting:', e);
              }
            }
            await deleteJob(job.id);
            setSelectedIds(prev => {
              const next = new Set(prev);
              next.delete(job.id);
              return next;
            });
          } catch (e) {
            console.error('Error deleting job:', job.name, e);
          }
          setDeleteProgress({ done: i + 1, total: jobsToDelete.length });
          refreshJobs();
        }
        setDeleteProgress(null);
        refresh();
      },
    });
  };

  const columns: TableColumn[] = [
    {
      title: (
        <input
          type="checkbox"
          checked={allSelected}
          onChange={toggleAll}
          disabled={isDeleting}
          className="cursor-pointer accent-blue-500"
        />
      ),
      key: 'select',
      className: 'w-8',
      render: row => (
        <input
          type="checkbox"
          checked={selectedIds.has(row.id)}
          onChange={() => toggleRow(row.id)}
          disabled={isDeleting}
          className="cursor-pointer accent-blue-500"
        />
      ),
    },
    {
      // fork addition, see FORK_NOTES.md - ReactNode titles need no UniversalTable change
      title: (
        <button
          type="button"
          onClick={cycleNameSort}
          title={nameSort === 'default' ? 'Sort A to Z' : nameSort === 'asc' ? 'Sort Z to A' : 'Restore default order'}
          className="inline-flex items-center gap-1 uppercase hover:text-white focus-visible:outline focus-visible:outline-blue-500"
        >
          Name
          {nameSort === 'default' ? (
            <ArrowUpDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : nameSort === 'asc' ? (
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span className="sr-only">
            {nameSort === 'default' ? 'Default order' : nameSort === 'asc' ? 'A to Z' : 'Z to A'}
          </span>
        </button>
      ),
      key: 'name',
      render: row => {
        let title = row.name;
        let href = `/jobs/${row.id}`;
        // if (row.job_type === 'train') title = `Train: ${title}`;
        if (row.job_type === 'inference') {
          href = `/generate?job=${row.id}`;
          title = (
            <>
              <small className="opacity-50">INFERENCE ENGINE: </small> {row.name}
            </>
          );
        }
        if (row.job_type === 'caption') {
          let splits = row.job_ref.split(/[/\\]/);
          const datasetPath = `${splits[splits.length - 1]}`;
          href = `/datasets/${datasetPath}`;
          title = (
            <>
              <small className="opacity-50">CAPTION: </small> {datasetPath}
            </>
          );
        }
        return (
          <Link href={href} className="font-medium whitespace-nowrap">
            {['running', 'stopping'].includes(row.status) ? (
              <CgSpinner className="inline animate-spin mr-2 text-blue-400" />
            ) : null}
            {title}
          </Link>
        );
      },
    },
    {
      title: 'Steps',
      key: 'steps',
      render: row => {
        const totalSteps = getTotalSteps(row);
        const displayStep = getDisplayStep(row);
        if (!totalSteps) {
          return <></>;
        }

        return (
          <div>
            <div className="text-xs text-gray-400">
              {displayStep} / {totalSteps}
            </div>
            <div className="bg-gray-700 rounded-full h-1.5">
              <div
                className="bg-blue-500 h-1.5 rounded-full"
                style={{ width: `${Math.min(100, (displayStep / totalSteps) * 100)}%` }}
              ></div>
            </div>
          </div>
        );
      },
    },
    {
      title: 'GPU',
      key: 'gpu_ids',
    },
    {
      title: 'Status',
      key: 'status',
      render: row => {
        let statusClass = 'text-gray-400';
        if (row.status === 'completed') statusClass = 'text-green-400';
        if (row.status === 'failed') statusClass = 'text-red-400';
        if (row.status === 'running') statusClass = 'text-blue-400';

        return <span className={statusClass}>{row.status}</span>;
      },
    },
    {
      title: 'Info',
      key: 'info',
      className: 'truncate max-w-xs',
      render: row => displayJobInfo(row),
    },
    {
      title: 'Actions',
      key: 'actions',
      className: 'text-right',
      render: row => {
        return <JobActionBar job={row} onRefresh={refreshJobs} autoStartQueue={false} />;
      },
    },
  ];

  let isLoading = status === 'loading' || queueStatus === 'loading' || !isGPUInfoLoaded;

  // if job dict is populated, we are always loaded
  if (Object.keys(jobsDict).length > 0) isLoading = false;

  return (
    <div>
      {!onlyActive && (
        <div className="flex min-w-0 flex-col items-start gap-x-3 sm:flex-row">
          <JobSearch
            value={search}
            onChange={value => {
              setSearch(value);
              setSelectedIds(new Set());
            }}
          />
          <JobStatusFilter
            value={statusFilter}
            onChange={value => {
              setSavedStatusFilter(value);
              setSelectedIds(new Set());
            }}
          />
        </div>
      )}
      {(selectedIds.size > 0 || isDeleting) && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 bg-gray-800 rounded-lg border border-gray-700 shadow-lg">
          {isDeleting ? (
            <>
              <CgSpinner className="inline animate-spin text-red-400" />
              <span className="text-sm text-gray-300">
                Deleting {deleteProgress.done} / {deleteProgress.total}...
              </span>
            </>
          ) : (
            <>
              <span className="text-sm text-gray-300 flex-1">
                {selectedIds.size} job{selectedIds.size === 1 ? '' : 's'} selected
              </span>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-xs text-gray-300 bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded"
              >
                Clear
              </button>
              <button
                onClick={onMassDelete}
                className="text-xs text-white bg-red-600 hover:bg-red-700 px-2 py-1 rounded flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete Selected
              </button>
            </>
          )}
        </div>
      )}
      {Object.keys(jobsDict)
        .sort()
        .filter(key => key !== 'Idle')
        .map(gpuKey => {
          const queue = queues.find(q => `${q.gpu_ids}` === gpuKey) as Queue;
          const collapsed = isCollapsed(gpuKey);
          const jobsInQueue = jobsDict[gpuKey].jobs;
          const summary = queueSummary(jobsInQueue);
          return (
            <div key={gpuKey} className="mb-6">
              <div
                className={classNames(
                  'text-md flex flex-wrap items-center gap-y-1 px-2 sm:px-4 py-1 rounded-t-lg',
                  { 'bg-green-600 dark:bg-green-900': queue?.is_running },
                  { 'bg-red-600 dark:bg-red-900': !queue?.is_running },
                  { 'rounded-b-lg': collapsed },
                )}
              >
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() => toggleQueue(gpuKey)}
                  className="mr-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-white hover:bg-black/20"
                >
                  {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  <span className="sr-only">{collapsed ? 'Expand queue' : 'Collapse queue'}</span>
                </button>
                <div className="flex items-center space-x-2 flex-1 min-w-0 py-2">
                  <h2 className="font-semibold text-white truncate">{jobsDict[gpuKey].name}</h2>
                  <span className="px-2 py-0.5 bg-gray-700 rounded-full text-xs text-gray-300 flex-shrink-0">
                    # {queue?.gpu_ids}
                  </span>
                </div>
                {collapsed && (
                  <p className="basis-full sm:basis-auto text-xs not-italic text-white/90 px-1">{summary}</p>
                )}
                <div className="text-sm text-gray-300 italic flex items-center flex-shrink-0 ml-auto">
                  {queue?.is_running ? (
                    <>
                      <span className="text-green-100 dark:text-green-400 mr-2">Queue Running</span>
                      <button
                        onClick={async () => {
                          await stopQueue(queue.gpu_ids as string);
                          refresh();
                        }}
                        className="ml-2 sm:ml-4 text-xs text-white bg-red-600 hover:bg-red-700 px-2 py-1 rounded"
                      >
                        STOP
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-red-100 dark:text-red-400 mr-2">Queue Stopped</span>
                      <button
                        onClick={async () => {
                          await startQueue(gpuKey);
                          refresh();
                        }}
                        className="ml-2 sm:ml-4 text-xs text-white bg-green-600 hover:bg-green-700 px-2 py-1 rounded"
                      >
                        START
                      </button>
                    </>
                  )}
                </div>
              </div>
              {!collapsed && (
                <UniversalTable
                  columns={columns}
                  rows={jobsInQueue}
                  isLoading={isLoading}
                  onRefresh={refresh}
                  theadClassName={
                    queue?.is_running
                      ? 'bg-green-700 dark:bg-green-950 text-white dark:text-gray-400'
                      : 'bg-red-700 dark:bg-red-950 text-white dark:text-gray-400'
                  }
                />
              )}
            </div>
          );
        })}
      {!onlyActive && Object.keys(jobsDict).includes('Idle') && (
        <div className="mb-6 opacity-50">
          <div className="text-md flex px-4 py-1 rounded-t-lg bg-slate-600">
            <div className="flex items-center space-x-2 flex-1 py-2">
              <h2 className="font-semibold text-gray-100">Idle</h2>
            </div>
          </div>
          <UniversalTable columns={columns} rows={jobsDict['Idle'].jobs} isLoading={isLoading} onRefresh={refresh} />
        </div>
      )}
    </div>
  );
}
