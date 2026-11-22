import { createGlobalState } from 'react-global-hooks';

// Read key for /api/img, /api/files and /api/audio/art URLs when a password is set.
// Empty otherwise. AuthWrapper sets it from /api/auth.
export const readKeyState = createGlobalState('');
export const READ_KEY_REJECTED_EVENT = 'aitk-read-key-rejected';

export const setReadKey = (key: string) => {
  readKeyState.set(key || '');
};

// for URLs built without encodeFilePathForUrl, which appends the key itself
export const withReadKey = (url: string) => {
  const readKey = readKeyState.get();
  if (!readKey) return url;
  return `${url}${url.includes('?') ? '&' : '?'}k=${readKey}`;
};
