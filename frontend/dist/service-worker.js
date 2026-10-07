/* eslint-disable no-restricted-globals */
/**
 * Stellar Royalty Splitter service worker (#522 / #830).
 *
 * Caching strategy:
 * - **App shell (HTML + JS + CSS)**: cache-first with network update. The
 *   shell rarely changes between deploys, and serving it from cache lets
 *   the UI boot offline.
 * - **API GET requests (/api/*)**: network-first with cache fallback.
 *   Results are stored in a dedicated API cache so the UI can display
 *   the last known contract state, history, and analytics when offline.
 *   Cached responses are served only when the network is unavailable.
 * - **Other GETs (icons, fonts, etc.)**: stale-while-revalidate. Return
 *   the cached copy immediately if present, refetch in the background.
 * - **POST / write requests while offline**: queued in IndexedDB under
 *   the `srs-write-queue` store. On `online` event (and periodic pings
 *   from the page while it stays online, see registerServiceWorker.ts)
 *   the queue is replayed in order, surfacing each completion as a
 *   `message` event so the UI can show toasts. Each queued item retries
 *   with exponential backoff (capped at 10 minutes between attempts,
 *   #771) instead of hammering the backend every cycle, and the queue is
 *   bounded to MAX_QUEUE_SIZE entries so a long offline stretch can't
 *   grow it unbounded.
 *
 * The cache version is bumped per shipped change so old caches are
 * dropped on `activate`.
 */

const CACHE_VERSION = "srs-v2";
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const API_CACHE = `${CACHE_VERSION}-api`;

const APP_SHELL = ["/", "/index.html"];

// API path prefixes whose GET responses should be cached for offline use.
const CACHEABLE_API_PREFIXES = [
  "/api/collaborators/",
  "/api/history/",
  "/api/analytics/",
  "/api/secondary-royalty/",
  "/api/contract/",
  "/api/audit/",
  "/api/transaction/",
];

const QUEUE_DB = "srs-sw-db";
const QUEUE_STORE = "srs-write-queue";
const MAX_QUEUE_SIZE = 100;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 10 * 60 * 1000; // 10 minutes

function computeBackoffMs(attempts) {
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempts), MAX_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// Install — pre-cache the app shell
// ---------------------------------------------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

// ---------------------------------------------------------------------------
// Activate — drop caches from prior versions
// ---------------------------------------------------------------------------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.startsWith(CACHE_VERSION))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ---------------------------------------------------------------------------
// IndexedDB helpers — write queue
// ---------------------------------------------------------------------------
function openQueueDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUEUE_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(QUEUE_STORE, {
        keyPath: "id",
        autoIncrement: true,
      });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueCount(db) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(QUEUE_STORE, "readonly").objectStore(QUEUE_STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Broadcast current queue count to all open clients using the
 * `srs-queue-updated` message type that `offlineQueue.ts` subscribes to.
 */
async function broadcastQueueCount() {
  const db = await openQueueDb();
  const count = await queueCount(db);
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clientsList) {
    client.postMessage({ type: "srs-queue-updated", count });
  }
}

/**
 * Queues a write, bounded at MAX_QUEUE_SIZE (#771).
 * Returns `{ accepted: false }` when the queue is already full.
 */
async function enqueueWrite(serialized) {
  const db = await openQueueDb();
  const count = await queueCount(db);
  if (count >= MAX_QUEUE_SIZE) {
    return { accepted: false };
  }
  await new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).add({
      ...serialized,
      attempts: 0,
      nextRetryAt: Date.now(),
      queuedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await broadcastQueueCount();
  return { accepted: true };
}

async function rescheduleRetry(db, item) {
  const attempts = item.attempts + 1;
  const nextRetryAt = Date.now() + computeBackoffMs(attempts);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).put({ ...item, attempts, nextRetryAt });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function drainQueue() {
  const db = await openQueueDb();
  const items = await new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readonly");
    const req = tx.objectStore(QUEUE_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const now = Date.now();
  let changed = false;

  for (const item of items) {
    if (now < item.nextRetryAt) continue; // still in backoff window

    try {
      const res = await fetch(item.url, {
        method: item.method,
        headers: item.headers,
        body: item.body,
      });
      if (res.ok) {
        await new Promise((resolve) => {
          const tx = db.transaction(QUEUE_STORE, "readwrite");
          tx.objectStore(QUEUE_STORE).delete(item.id);
          tx.oncomplete = () => resolve();
        });
        changed = true;
        const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
        for (const client of clientsList) {
          client.postMessage({ type: "srs-write-replayed", url: item.url });
        }
      } else {
        await rescheduleRetry(db, item);
        changed = true;
      }
    } catch {
      // Network still down — back off and try again next cycle.
      await rescheduleRetry(db, item);
      changed = true;
    }
  }

  if (changed) await broadcastQueueCount();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isCacheableApiGet(url) {
  return CACHEABLE_API_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Fetch handler
// ---------------------------------------------------------------------------
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin requests; let the browser handle CDN/RPC.
  if (url.origin !== self.location.origin) return;

  // ── Write requests: try network first, queue on failure ──────────────────
  if (req.method !== "GET") {
    event.respondWith(
      fetch(req.clone()).catch(async () => {
        const body = await req.clone().text();
        const headers = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        const { accepted } = await enqueueWrite({
          url: req.url,
          method: req.method,
          headers,
          body,
        });
        if (!accepted) {
          return new Response(
            JSON.stringify({
              queued: false,
              offline: true,
              error: "offline_queue_full",
              message:
                "Offline queue is full (max 100 pending writes). Please retry once back online.",
            }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ queued: true, offline: true }),
          {
            status: 202,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );
    return;
  }

  // ── API GETs: network-first, fall back to cache ───────────────────────────
  if (isCacheableApiGet(url)) {
    event.respondWith(
      fetch(req.clone())
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(API_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) {
            // Add a header so the UI can optionally flag stale data.
            const body = await cached.clone().text();
            return new Response(body, {
              status: cached.status,
              statusText: cached.statusText,
              headers: new Headers({
                ...Object.fromEntries(cached.headers.entries()),
                "X-SRS-Cache": "hit",
              }),
            });
          }
          return new Response(
            JSON.stringify({ error: "Offline and no cached data available." }),
            {
              status: 503,
              headers: { "Content-Type": "application/json" },
            },
          );
        }),
    );
    return;
  }

  // ── App shell: cache-first ────────────────────────────────────────────────
  if (APP_SHELL.includes(url.pathname) || url.pathname === "/index.html") {
    event.respondWith(
      caches.match(req).then((hit) =>
        hit ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(APP_SHELL_CACHE).then((c) => c.put(req, copy));
          return res;
        }),
      ),
    );
    return;
  }

  // ── Everything else: stale-while-revalidate ───────────────────────────────
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
self.addEventListener("message", async (event) => {
  if (!event.data) return;

  if (event.data.type === "srs-drain-queue") {
    event.waitUntil(drainQueue());
  }

  if (event.data.type === "srs-get-queue-size") {
    event.waitUntil(broadcastQueueCount());
  }
});
