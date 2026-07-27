'use client';

// Fork-only (see FORK_NOTES.md). Session toggle for revealing extra field help
// icons on the New Training Job form.

import { createGlobalState } from 'react-global-hooks';

export const helpModeState = createGlobalState(false);

export default function useHelpMode(): boolean {
  const [helpMode] = helpModeState.use();
  return helpMode;
}

export function setHelpMode(value: boolean) {
  helpModeState.set(value);
}

export function toggleHelpMode() {
  helpModeState.set(!helpModeState.get());
}
