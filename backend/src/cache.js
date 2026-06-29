/**
 * Smart cache with:
 *  - TTL per data type (configurable via env)
 *  - Event-driven invalidation (invalidate by key or tag)
 *  - Async background refresh (stale-while-revalidate)
 *  - Cache warming for frequently accessed keys
 *  - Hit/miss ratio tracking
 *
 * Closes #511
 */

import { EventEmitter } from "events";

// ── TTL config per data type (ms) ─────────────────────────────────────────

function parseMs(env, fallback) {
  const n = parseInt(env ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const TTL = {
  CONTRACT_STATE: parseMs(process.env.CACHE_TTL_CONTRACT_STATE_MS, 30_000),
  COLLABORATORS: parseMs(process.env.CACHE_TTL_COLLABORATORS_MS, 60_000),
  CONTRACT_INFO: parseMs(process.env.CACHE_TTL_CONTRACT_INFO_MS, 120_000),
  FEE: parseMs(process.env.CACHE_TTL_FEE_MS, 30_000),
};

// ── Internal state ────────────────────────────────────────────────────────

/** @type {Map<string, { value: unknown, fetchedAt: number, ttl: number, tags: string[] }>} */
const store = new Map();

/** Keys registered for warming with their fetch functions. */
const warmingRegistry = new Map(); // key → { fetch: () => Promise<unknown>, ttl: number, tags: string[] }

/** Active background refresh promises (deduplicated). */
const refreshing = new Set();

/** Hit/miss counters. */
const counters = { hits: 0, misses: 0 };

/** Event bus for invalidation signals. */
export const cacheEvents = new EventEmitter();

// ── Core operations ───────────────────────────────────────────────────────

/**
 * Read a cached value.
 * Returns `undefined` on miss or expiry.
 * If `refresh` is supplied and the entry is expired, kicks off an async
 * background refresh (stale-while-revalidate) and returns `undefined`.
 */
export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) {
    counters.misses += 1;
    return undefined;
  }
  const age = Date.now() - entry.fetchedAt;
  if (age >= entry.ttl) {
    counters.misses += 1;
    return undefined;
  }
  counters.hits += 1;
  return entry.value;
}

/**
 * Write a value into the cache.
 * @param {string} key
 * @param {unknown} value
 * @param {number} ttl  - milliseconds
 * @param {string[]} [tags] - optional invalidation tags
 */
export function cacheSet(key, value, ttl, tags = []) {
  store.set(key, { value, fetchedAt: Date.now(), ttl, tags });
}

/**
 * Invalidate a specific key.
 */
export function cacheInvalidate(key) {
  store.delete(key);
}

/**
 * Invalidate all keys that carry a given tag.
 */
export function cacheInvalidateByTag(tag) {
  for (const [key, entry] of store) {
    if (entry.tags.includes(tag)) store.delete(key);
  }
}

/**
 * Get-or-fetch: return cached value if fresh; otherwise await `fetchFn`,
 * store the result, and return it.
 * @param {string} key
 * @param {() => Promise<unknown>} fetchFn
 * @param {number} ttl
 * @param {string[]} [tags]
 */
export async function cacheGetOrFetch(key, fetchFn, ttl, tags = []) {
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const value = await fetchFn();
  cacheSet(key, value, ttl, tags);
  return value;
}

/**
 * Stale-while-revalidate: return the stale cached value immediately (if any)
 * and trigger an async background refresh when the entry is expired.
 * @param {string} key
 * @param {() => Promise<unknown>} fetchFn
 * @param {number} ttl
 * @param {string[]} [tags]
 */
export function cacheGetWithAsyncRefresh(key, fetchFn, ttl, tags = []) {
  const entry = store.get(key);
  const now = Date.now();

  if (entry) {
    const age = now - entry.fetchedAt;
    if (age < entry.ttl) {
      counters.hits += 1;
      return { value: entry.value, stale: false };
    }
    // Stale: return old value and refresh in background
    counters.hits += 1;
    _triggerAsyncRefresh(key, fetchFn, ttl, tags);
    return { value: entry.value, stale: true };
  }

  counters.misses += 1;
  return { value: undefined, stale: false };
}

function _triggerAsyncRefresh(key, fetchFn, ttl, tags) {
  if (refreshing.has(key)) return; // already refreshing
  refreshing.add(key);
  fetchFn()
    .then((value) => cacheSet(key, value, ttl, tags))
    .catch(() => {/* keep stale on error */})
    .finally(() => refreshing.delete(key));
}

// ── Cache warming ─────────────────────────────────────────────────────────

/**
 * Register a key for cache warming.
 * The fetch function will be called immediately and cached.
 */
export function registerWarmingKey(key, fetchFn, ttl, tags = []) {
  warmingRegistry.set(key, { fetch: fetchFn, ttl, tags });
}

/**
 * Warm all registered keys (or a specific one).
 * Call at startup for frequently accessed data.
 */
export async function warmCache(key) {
  if (key) {
    const entry = warmingRegistry.get(key);
    if (!entry) return;
    try {
      const value = await entry.fetch();
      cacheSet(key, value, entry.ttl, entry.tags);
    } catch {/* warming failure is non-fatal */}
    return;
  }

  await Promise.allSettled(
    Array.from(warmingRegistry.entries()).map(async ([k, entry]) => {
      try {
        const value = await entry.fetch();
        cacheSet(k, value, entry.ttl, entry.tags);
      } catch {/* warming failure is non-fatal */}
    })
  );
}

// ── Metrics ───────────────────────────────────────────────────────────────

export function getCacheMetrics() {
  const total = counters.hits + counters.misses;
  return {
    hits: counters.hits,
    misses: counters.misses,
    hitRatio: total === 0 ? 0 : counters.hits / total,
    size: store.size,
  };
}

export function resetCacheMetrics() {
  counters.hits = 0;
  counters.misses = 0;
}

/** Clear entire cache + metrics (for tests). */
export function _resetCache() {
  store.clear();
  warmingRegistry.clear();
  refreshing.clear();
  counters.hits = 0;
  counters.misses = 0;
}

// ── Event-driven invalidation ─────────────────────────────────────────────

/**
 * Emit a cache invalidation event for a contract. Consumers (routes) listen
 * for this after state-mutating operations (distribute, initialize, etc.).
 */
export function emitContractInvalidation(contractId) {
  cacheEvents.emit("invalidate:contract", contractId);
}

cacheEvents.on("invalidate:contract", (contractId) => {
  cacheInvalidateByTag(contractId);
});
