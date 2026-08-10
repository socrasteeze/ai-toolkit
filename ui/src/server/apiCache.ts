type CacheEntry = {
  promise: Promise<unknown>;
  timestamp: number;
  pending: boolean;
};

const cache = new Map<string, CacheEntry>();

const DEFAULT_STALE_TIME_MS = 5000;
export const CACHE_PENDING_TIMEOUT_MS = 30_000;

/**
 * Universal cache for slow API work. Results are cached per key + params and
 * reused until they go stale. Concurrent callers while a fetch is in flight
 * share the same promise instead of triggering duplicate work.
 *
 * @param key        Unique name for this cached operation (e.g. 'cpu-info')
 * @param fetcher    Function that produces a fresh value
 * @param staleTimeMs How long a cached value stays fresh (default 5000ms)
 * @param params     Optional params; different params get separate cache entries
 */
export async function cached<T>(
  key: string,
  fetcher: () => Promise<T>,
  staleTimeMs: number = DEFAULT_STALE_TIME_MS,
  params: unknown = null,
): Promise<T> {
  const cacheKey = params === null ? key : `${key}:${JSON.stringify(params)}`;
  const now = Date.now();

  const entry = cache.get(cacheKey);
  // Share in-flight work past the result TTL, but not forever. A fetcher that
  // never settles must not poison this key for the lifetime of the server.
  // The previous start-time TTL could launch duplicate slow work (for example,
  // a six-second peer probe behind a five-second cache) while the first request
  // was still running.
  if (entry) {
    const age = now - entry.timestamp;
    if ((entry.pending && age < CACHE_PENDING_TIMEOUT_MS) || (!entry.pending && age < staleTimeMs)) {
      return entry.promise as Promise<T>;
    }
  }

  const promise = fetcher();
  const nextEntry: CacheEntry = { promise, timestamp: now, pending: true };
  cache.set(cacheKey, nextEntry);

  void promise.then(
    () => {
      // Freshness begins when the slow work finishes, not when it starts.
      if (cache.get(cacheKey)?.promise === promise) {
        nextEntry.pending = false;
        nextEntry.timestamp = Date.now();
      }
    },
    () => {
      // Drop failed fetches so the next call retries instead of caching the error.
      if (cache.get(cacheKey)?.promise === promise) {
        cache.delete(cacheKey);
      }
    },
  );

  return promise;
}

/** Remove a cached entry (all param variants if no params given). */
export function invalidateCache(key: string, params: unknown = null): void {
  if (params !== null) {
    cache.delete(`${key}:${JSON.stringify(params)}`);
    return;
  }
  cache.delete(key);
  for (const cacheKey of cache.keys()) {
    if (cacheKey.startsWith(`${key}:`)) {
      cache.delete(cacheKey);
    }
  }
}
