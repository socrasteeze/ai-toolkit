'use client';

import { GitCompare } from 'lucide-react';
import { TopBar, MainContent } from '@/components/layout';
import CheckpointCompare from '@/components/CheckpointCompare';

export default function CheckpointComparePage() {
  return (
    <>
      <TopBar>
        <div className="flex items-center gap-2">
          <GitCompare className="w-5 h-5 text-blue-400" />
          <h1 className="text-base sm:text-lg">Checkpoint Compare</h1>
        </div>
      </TopBar>
      <MainContent>
        <CheckpointCompare />
      </MainContent>
    </>
  );
}
