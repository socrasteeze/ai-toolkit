'use client';

// Fork-only component (see FORK_NOTES.md). TopBar toggle that reveals CircleHelp
// icons on New Training Job fields that do not already have always-on docs.

import { Button } from '@headlessui/react';
import classNames from 'classnames';
import useHelpMode, { toggleHelpMode } from '@/hooks/useHelpMode';

export default function HelpModeButton() {
  const helpMode = useHelpMode();

  return (
    <Button
      className={classNames(
        'px-2 sm:px-3 py-1 rounded-md text-xs sm:text-base',
        helpMode ? 'text-white bg-blue-700 hover:bg-blue-600' : 'text-gray-200 bg-gray-800',
      )}
      onClick={() => toggleHelpMode()}
      title={helpMode ? 'Hide extra field help icons' : 'Show help icons on fields without them'}
    >
      Help
    </Button>
  );
}
