/* eslint-disable no-restricted-globals */
/**
 * Stellar Royalty Splitter service worker (#522).
 *
 * Caching strategy:
 * - **App shell (HTML + JS + CSS)**: cache-first with network update. The
 *   shell rarely changes between deploys, and serving it from cache lets
 *   the UI boot offline.
 * - **Other GETs (icons, fonts, etc.)**: stale-while-revalidate. Return
 *   the cached copy immediately if present, refetch in the background.
 * - **POST / write requests while offline**: queued in IndexedDB under
 *   the `srs-write-queue` store. On `online` event the queue is replayed
 *   in order, surfacing each completion as a `message` event so the UI
 *   can show toasts. (Replay is best-effort — failed replays stay queued
 *   for the next online cycle.)
 *
 * The cache version is bumped per shipped change so old caches are
 * dropped on `activate`.
 */

const CACHE_VERSION = "srs-v1";
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL = [
  "/",
  "/index.html",
];

const QUEUE_DB = "srs-sw-db";
const QUEUE_STORE = "srs-write-queue";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

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

async function enqueueWrite(serialized) {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).add(serialized);
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
  for (const item of items) {
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
        const clientsList = await self.clients.matchAll();
        for (const client of clientsList) {
          client.postMessage({ type: "srs-write-replayed", url: item.url });
        }
      }
    } catch {
      // Leave in queue; the next online cycle will retry.
    }
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin requests; let the browser handle CDN/RPC.
  if (url.origin !== self.location.origin) return;

  // Write requests: try network first, queue on failure.
  if (req.method !== "GET") {
    event.respondWith(
      fetch(req.clone()).catch(async () => {
        const body = await req.clone().text();
        const headers = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        await enqueueWrite({ url: req.url, method: req.method, headers, body });
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

  // App shell: cache-first.
  if (APP_SHELL.includes(url.pathname) || url.pathname === "/index.html") {
    event.respondWith(
      caches
        .match(req)
        .then((hit) => hit || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(APP_SHELL_CACHE).then((c) => c.put(req, copy));
          return res;
        })),
    );
    return;
  }

  // Everything else: stale-while-revalidate.
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

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "srs-drain-queue") {
    event.waitUntil(drainQueue());
  }
});
