import assert from 'node:assert/strict';
import test from 'node:test';

import { CACHE_PENDING_TIMEOUT_MS, cached, invalidateCache } from '../src/server/apiCache.ts';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a slow in-flight fetch stays deduplicated past its TTL', async () => {
  const key = `slow-${Date.now()}-${Math.random()}`;
  let calls = 0;
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const fetcher = () => {
    calls += 1;
    return gate;
  };

  const first = cached(key, fetcher, 20);
  await wait(30);
  const second = cached(key, fetcher, 20);

  assert.equal(calls, 1);

  release('done');
  assert.equal(await first, 'done');
  assert.equal(await second, 'done');

  // Freshness starts at completion, so the result remains reusable now.
  assert.equal(await cached(key, fetcher, 20), 'done');
  assert.equal(calls, 1);
  invalidateCache(key);
});

test('a rejected fetch is evicted for the next caller', async () => {
  const key = `reject-${Date.now()}-${Math.random()}`;
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (calls === 1) throw new Error('first call fails');
    return 'recovered';
  };

  await assert.rejects(cached(key, fetcher, 1000), /first call fails/);
  assert.equal(await cached(key, fetcher, 1000), 'recovered');
  assert.equal(calls, 2);
  invalidateCache(key);
});

test('a never-settling fetch is replaceable after the pending deadline', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const key = `hung-${now}-${Math.random()}`;
  let calls = 0;
  const never = new Promise(() => {});
  const fetcher = () => {
    calls += 1;
    return calls === 1 ? never : Promise.resolve('retry succeeded');
  };

  try {
    void cached(key, fetcher, 5_000);
    now += CACHE_PENDING_TIMEOUT_MS + 1;
    assert.equal(await cached(key, fetcher, 5_000), 'retry succeeded');
    assert.equal(calls, 2);
  } finally {
    Date.now = realNow;
    invalidateCache(key);
  }
});
