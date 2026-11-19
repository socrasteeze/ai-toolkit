'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'aitk_queue_collapsed';

function readCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const next: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === true) next[key] = true;
    }
    return next;
  } catch {
    return {};
  }
}

/** Per-queue collapse flags. Absent means expanded, so a new queue is open. */
export default function useCollapsedQueues() {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  const toggleQueue = (id: string) => {
    setCollapsed(prev => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Keep the choice for this mount when browser storage is unavailable.
      }
      return next;
    });
  };

  return {
    isCollapsed: (id: string) => collapsed[id] === true,
    toggleQueue,
  };
}
