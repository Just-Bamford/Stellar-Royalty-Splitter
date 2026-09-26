/**
 * Multi-layer cache with predictive warming and fine-grained invalidation (#970).
 *
 * Architecture:
 *   L1 — Hot cache      : up to HOT_MAX (default 10) most-accessed keys, refreshed every 30s
 *   L2 — Warm cache     : recently accessed keys, refreshed on-demand via stale-while-revalidate
 *   L3 — Cold storage   : Redis when REDIS_URL is set; falls back to an in-process Map with
 *                         long TTL so the three-layer model works without a Redis deployment.
 *
 * Invalidation:
 *   invalidateKey(key)        – remove a single key from all layers
 *   invalidatePattern(prefix) – remove all keys whose string starts with prefix
 *   invalidateTag(tag)        – remove all keys registered under a tag
 *
 * Access-pattern tracking drives predictive warming:
 *   recordAccess(key) increments a counter; the hot-cache scheduler promotes the
 *   HOT_MAX most-accessed keys and keeps them refreshed every HOT_REFRESH_MS.
 *
 * Public API (backwards-compatible with previous single-layer API):
 *   configureCache(fn)                           – set the async fetch function
 *   cacheGet(key)                                – read (L1 → L2 → L3)
 *   cacheSet(key, value, ttlMs?, tags?)          – write to all layers
 *   refreshContract(key)                         – force a background refresh
 *   recordAccess(key)                            – track access for hot promotion
 *   invalidateKey(key)                           – targeted invalidation
 *   invalidatePattern(prefix)                    – prefix-based invalidation
 *   invalidateTag(tag)                           – tag-based invalidation
 *   startCacheWarmingScheduler(fn, ms, batch)    – background warming loop
 *   getMetrics() / resetMetrics()                – observability
 */

import logger from "./logger.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS        = 60_000;
const DEFAULT_WARM_LEAD_MS  = 30_000;
const DEFAULT_L3_TTL_MS     = 600_000; // 10 min cold TTL
const HOT_MAX               = parseInt(process.env.CACHE_HOT_MAX        ?? "10",     10);
const HOT_REFRESH_MS        = parseInt(process.env.CACHE_HOT_REFRESH_MS ?? "30000",  10);
const L3_TTL_MS             = parseInt(process.env.CACHE_L3_TTL_MS      ?? String(DEFAULT_L3_TTL_MS), 10);

const TTL_MS           = parseInt(process.env.CACHE_TTL_MS           ?? String(DEFAULT_TTL_MS),      10);
const WARM_LEAD_TIME_MS = parseInt(process.env.CACHE_WARM_LEAD_TIME_MS ?? String(DEFAULT_WARM_LEAD_MS), 10);
const WARMING_ENABLED  = WARM_LEAD_TIME_MS < TTL_MS;

// ---------------------------------------------------------------------------
// Layer stores
// ---------------------------------------------------------------------------

/** L1 — hot set (most-accessed keys, size-bounded). */
const hotStore  = new Map(); // key → { value, expiresAt, fetchedAt }

/** L2 — warm store (all recently written keys). */
const warmStore = new Map(); // key → { value, expiresAt, fetchedAt }

/**
 * L3 — cold store.
 * When Redis is configured (REDIS_URL env) we delegate to a thin async wrapper;
 * otherwise we use a local Map so the three-layer contract is always satisfied.
 */
const coldStore = new Map(); // key → { value, expiresAt }   (in-process fallback)

// ---------------------------------------------------------------------------
// Tag → key index (for tag-based invalidation)
// ---------------------------------------------------------------------------

const tagIndex = new Map(); // tag → Set<key>

// ---------------------------------------------------------------------------
// Inflight / access tracking
// ---------------------------------------------------------------------------

const refreshInFlight = new Map(); // key → Promise
const accessCount     = new Map(); // key → number

// ---------------------------------------------------------------------------
// Fetch function (injected by caller)
// ---------------------------------------------------------------------------

let fetchFunction = null;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const metrics = {
  hits:              0,
  misses:            0,
  staleServes:       0,
  l1Hits:            0,
  l2Hits:            0,
  l3Hits:            0,
  refreshLatencyMs:  0,
  invalidations:     0,
};

// ---------------------------------------------------------------------------
// Redis adapter (optional)
// ---------------------------------------------------------------------------

/**
 * Thin async wrapper around an ioredis/redis client.
 * Only instantiated when REDIS_URL is present and the package is available.
 */
let _redis = null;

async function _initRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return;
  try {
    // Dynamic import so the module loads fine when redis is not installed.
    const { default: Redis } = await import("ioredis");
    _redis = new Redis(url, { lazyConnect: true, enableReadyCheck: false });
    _redis.on("error", (err) =>
      logger.warn("Redis cache error (L3 falling back to in-process Map)", { error: err.message })
    );
    await _redis.connect().catch(() => {});
    logger.info("Cache L3: Redis connected", { url: url.replace(/\/\/.*@/, "//***@") });
  } catch {
    logger.info("Cache L3: ioredis not available, using in-process fallback Map");
  }
}
_initRedis();

async function l3Get(key) {
  if (_redis) {
    try {
      const raw = await _redis.get(`cache:${key}`);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      /* fall through to local Map */
    }
  }
  const entry = coldStore.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) { coldStore.delete(key); return undefined; }
  return entry.value;
}

async function l3Set(key, value, ttlMs = L3_TTL_MS) {
  if (_redis) {
    try {
      await _redis.set(`cache:${key}`, JSON.stringify(value), "PX", ttlMs);
      return;
    } catch {
      /* fall through */
    }
  }
  coldStore.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function l3Delete(key) {
  if (_redis) {
    try { await _redis.del(`cache:${key}`); } catch { /* ignore */ }
  }
  coldStore.delete(key);
}

async function l3Keys() {
  if (_redis) {
    try {
      const keys = await _redis.keys("cache:*");
      return keys.map((k) => k.replace(/^cache:/, ""));
    } catch { /* fall through */ }
  }
  return [...coldStore.keys()];
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

function _registerTags(key, tags = []) {
  for (const tag of tags) {
    if (!tagIndex.has(tag)) tagIndex.set(tag, new Set());
    tagIndex.get(tag).add(key);
  }
}

function _deregisterKey(key) {
  for (const set of tagIndex.values()) set.delete(key);
}

// ---------------------------------------------------------------------------
// Core write — writes to L1 (if hot) and L2; L3 write is async fire-and-forget
// ---------------------------------------------------------------------------

/**
 * Configure the cache with an async fetch function.
 * Must be called before refreshContract / startCacheWarmingScheduler.
 */
export function configureCache(fn) {
  if (typeof fn !== "function") throw new TypeError("fetch function must be a function");
  fetchFunction = fn;
}

/**
 * Write a value to the cache.
 * @param {string}   key
 * @param {*}        value
 * @param {number}   [ttlMs]  – L1/L2 TTL (defaults to CACHE_TTL_MS)
 * @param {string[]} [tags]   – arbitrary tags for grouped invalidation
 */
export function cacheSet(key, value, ttlMs = TTL_MS, tags = []) {
  const now = Date.now();
  const entry = { value, fetchedAt: now, expiresAt: now + ttlMs };

  // Always write to L2 (warm)
  warmStore.set(key, entry);

  // Promote to L1 (hot) if this key is already tracked as hot
  if (hotStore.has(key)) hotStore.set(key, entry);

  // Register tags
  _registerTags(key, tags);

  // Write to L3 asynchronously (non-blocking)
  l3Set(key, value, L3_TTL_MS).catch(() => {});
}

// ---------------------------------------------------------------------------
// Core read — L1 → L2 → L3
// ---------------------------------------------------------------------------

/**
 * Read a value from the cache.
 *
 * Layer resolution order: L1 (hot) → L2 (warm) → L3 (cold).
 * Stale-while-revalidate: within the warm lead-time window a stale L2 entry
 * is served immediately while a background refresh is kicked off.
 * Returns undefined on a full cache miss (caller should fetch and cacheSet).
 */
export function cacheGet(key) {
  const now = Date.now();

  // --- L1 check ---
  const hotEntry = hotStore.get(key);
  if (hotEntry) {
    if (now < hotEntry.expiresAt) {
      metrics.hits++;
      metrics.l1Hits++;
      return hotEntry.value;
    }
    hotStore.delete(key);
  }

  // --- L2 check ---
  const warmEntry = warmStore.get(key);
  if (warmEntry) {
    const isExpired      = now >= warmEntry.expiresAt;
    const isWarmingWindow = WARMING_ENABLED && now >= warmEntry.expiresAt - WARM_LEAD_TIME_MS;

    if (isExpired) {
      warmStore.delete(key);
      // Fall through to L3
    } else if (isWarmingWindow) {
      if (!refreshInFlight.has(key)) refreshContract(key);
      metrics.staleServes++;
      metrics.l2Hits++;
      return warmEntry.value;
    } else {
      metrics.hits++;
      metrics.l2Hits++;
      return warmEntry.value;
    }
  }

  // --- L3 check (sync fast-path via in-process fallback; async path returns undefined) ---
  const coldEntry = coldStore.get(key);
  if (coldEntry) {
    if (now < coldEntry.expiresAt) {
      metrics.hits++;
      metrics.l3Hits++;
      // Promote back to L2 on read
      warmStore.set(key, { value: coldEntry.value, fetchedAt: now, expiresAt: now + TTL_MS });
      return coldEntry.value;
    }
    coldStore.delete(key);
  }

  // Redis L3 is async — trigger a background fetch-and-promote but return miss now
  if (_redis) {
    l3Get(key).then((value) => {
      if (value !== undefined) {
        warmStore.set(key, { value, fetchedAt: Date.now(), expiresAt: Date.now() + TTL_MS });
      }
    }).catch(() => {});
  }

  metrics.misses++;
  return undefined;
}

// ---------------------------------------------------------------------------
// Background refresh
// ---------------------------------------------------------------------------

/**
 * Force a background refresh for key.
 * If a refresh is already in-flight for this key, returns the existing promise.
 */
export function refreshContract(key) {
  if (!fetchFunction) {
    logger.warn("Cache refresh attempted but no fetch function configured", { key });
    return Promise.resolve();
  }
  if (refreshInFlight.has(key)) return refreshInFlight.get(key);

  const promise = (async () => {
    const start = Date.now();
    try {
      const freshValue = await fetchFunction(key);
      cacheSet(key, freshValue);
      metrics.refreshLatencyMs += Date.now() - start;
      logger.info("Cache refreshed", { key, layer: "L1/L2/L3", durationMs: Date.now() - start });
    } catch (error) {
      logger.error("Cache background refresh failed", { key, error });
      // Keep stale data — do not evict
    } finally {
      refreshInFlight.delete(key);
    }
  })();

  refreshInFlight.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Remove a single key from all cache layers.
 */
export function invalidateKey(key) {
  hotStore.delete(key);
  warmStore.delete(key);
  l3Delete(key).catch(() => {});
  _deregisterKey(key);
  metrics.invalidations++;
  logger.info("Cache invalidated", { key });
}

/**
 * Remove all keys whose string representation starts with `prefix`.
 */
export function invalidatePattern(prefix) {
  let count = 0;
  for (const key of [...warmStore.keys(), ...hotStore.keys()]) {
    if (String(key).startsWith(prefix)) {
      invalidateKey(key);
      count++;
    }
  }
  // Also sweep L3 in-process fallback
  for (const key of coldStore.keys()) {
    if (String(key).startsWith(prefix)) {
      coldStore.delete(key);
      count++;
    }
  }
  logger.info("Cache pattern invalidated", { prefix, count });
}

/**
 * Remove all keys registered under the given tag.
 */
export function invalidateTag(tag) {
  const keys = tagIndex.get(tag);
  if (!keys || keys.size === 0) return;
  let count = 0;
  for (const key of [...keys]) {
    invalidateKey(key);
    count++;
  }
  tagIndex.delete(tag);
  logger.info("Cache tag invalidated", { tag, count });
}

// ---------------------------------------------------------------------------
// Access tracking (drives L1 hot promotion)
// ---------------------------------------------------------------------------

/**
 * Increment the access counter for a key.
 * Call this each time a value is served (from cache or fetch).
 */
export function recordAccess(key) {
  accessCount.set(key, (accessCount.get(key) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// Hot cache scheduler (L1 — refreshes top HOT_MAX keys every HOT_REFRESH_MS)
// ---------------------------------------------------------------------------

function _updateHotSet(contracts) {
  // Sort all known keys by access count; promote top HOT_MAX to hot store
  const ranked = [...accessCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, HOT_MAX)
    .map(([key]) => key);

  // Evict keys no longer in top HOT_MAX
  for (const key of hotStore.keys()) {
    if (!ranked.includes(key)) hotStore.delete(key);
  }

  // Refresh each hot key
  for (const key of ranked) {
    const warmEntry = warmStore.get(key);
    if (warmEntry) {
      hotStore.set(key, warmEntry);
    }
    // Trigger background refresh regardless so hot entries stay fresh
    if (!refreshInFlight.has(key)) refreshContract(key).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Background warming scheduler (L2 — predictive refresh of active contracts)
// ---------------------------------------------------------------------------

/**
 * Start the background cache warming scheduler.
 *
 * @param {Function} getActiveContracts – async () => string[]  (contract keys to warm)
 * @param {number}   intervalMs         – how often to run (default 60 s)
 * @param {number}   batchSize          – max keys per tick (default 10)
 */
export function startCacheWarmingScheduler(
  getActiveContracts,
  intervalMs = 60_000,
  batchSize  = 10
) {
  if (typeof getActiveContracts !== "function") {
    throw new TypeError("getActiveContracts must be a function");
  }

  // Hot-cache refresh loop (L1)
  const hotInterval = setInterval(() => {
    _updateHotSet();
  }, HOT_REFRESH_MS);
  hotInterval.unref?.();

  // Warm-cache refresh loop (L2)
  const warmInterval = setInterval(async () => {
    try {
      let contracts = await getActiveContracts();
      if (!Array.isArray(contracts)) contracts = [];

      // Prioritize by access count (predictive warming)
      contracts.sort(
        (a, b) => (accessCount.get(b) ?? 0) - (accessCount.get(a) ?? 0)
      );

      const toRefresh = contracts.slice(0, batchSize);
      for (const contract of toRefresh) {
        // Spread load with jitter to avoid thundering herd
        const delay = Math.random() * (intervalMs / 2);
        setTimeout(() => refreshContract(contract).catch(() => {}), delay);
      }
    } catch (error) {
      logger.error("Cache warming scheduler failed", { error });
    }
  }, intervalMs);
  warmInterval.unref?.();

  return {
    stop() {
      clearInterval(hotInterval);
      clearInterval(warmInterval);
    },
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export { metrics };

export function getMetrics() {
  return {
    ...metrics,
    l1Size: hotStore.size,
    l2Size: warmStore.size,
    l3Size: coldStore.size,
    hotKeys: [...hotStore.keys()],
  };
}

export function resetMetrics() {
  metrics.hits             = 0;
  metrics.misses           = 0;
  metrics.staleServes      = 0;
  metrics.l1Hits           = 0;
  metrics.l2Hits           = 0;
  metrics.l3Hits           = 0;
  metrics.refreshLatencyMs = 0;
  metrics.invalidations    = 0;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function __test__clear() {
  hotStore.clear();
  warmStore.clear();
  coldStore.clear();
  tagIndex.clear();
  refreshInFlight.clear();
  accessCount.clear();
  resetMetrics();
}
