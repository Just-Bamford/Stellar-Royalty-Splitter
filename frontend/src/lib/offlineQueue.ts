/**
 * Main-thread view of the offline write queue (#771).
 *
 * The service worker (public/service-worker.js) owns writing to this
 * IndexedDB store — it queues same-origin POST/PATCH requests that fail
 * while offline, retries them with exponential backoff, and caps the
 * queue at MAX_QUEUE_SIZE. This module gives the React app read/clear
 * access to the same store (IndexedDB is shared across the page and its
 * service worker on the same origin) so the UI can show a pending count
 * and let the user clear the queue manually.
 */

export const QUEUE_DB_NAME = "srs-sw-db";
export const QUEUE_STORE_NAME = "srs-write-queue";
export const MAX_QUEUE_SIZE = 100;
export const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 10 * 60 * 1000; // 10 minutes

export interface QueuedWrite {
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  attempts: number;
  nextRetryAt: number;
  queuedAt: number;
}

/**
 * Exponential backoff for retry attempt N (0-indexed): doubles each
 * attempt starting at BASE_BACKOFF_MS, capped at MAX_BACKOFF_MS so a
 * long-offline stretch never waits longer than 10 minutes between tries.
 */
export function computeBackoffMs(attempts: number): number {
  const delay = BASE_BACKOFF_MS * Math.pow(2, attempts);
  return Math.min(delay, MAX_BACKOFF_MS);
}

function openQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this environment"));
      return;
    }
    const request = indexedDB.open(QUEUE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE_NAME)) {
        db.createObjectStore(QUEUE_STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open offline queue DB"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** All requests currently queued for retry, oldest first. */
export async function getQueuedWrites(): Promise<QueuedWrite[]> {
  try {
    const db = await openQueueDb();
    const tx = db.transaction(QUEUE_STORE_NAME, "readonly");
    const rows = await requestToPromise(tx.objectStore(QUEUE_STORE_NAME).getAll());
    db.close();
    return (rows as QueuedWrite[]).sort((a, b) => a.queuedAt - b.queuedAt);
  } catch {
    return [];
  }
}

export async function getQueueCount(): Promise<number> {
  try {
    const db = await openQueueDb();
    const tx = db.transaction(QUEUE_STORE_NAME, "readonly");
    const count = await requestToPromise(tx.objectStore(QUEUE_STORE_NAME).count());
    db.close();
    return count;
  } catch {
    return 0;
  }
}

/** Manually discards every queued write. Used by the "Clear queue" action. */
export async function clearQueue(): Promise<void> {
  try {
    const db = await openQueueDb();
    const tx = db.transaction(QUEUE_STORE_NAME, "readwrite");
    tx.objectStore(QUEUE_STORE_NAME).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to clear offline queue"));
    });
    db.close();
  } catch {
    // Best-effort — nothing to clear if IndexedDB is unavailable.
  }
}

export type QueueUpdateListener = (count: number) => void;

/**
 * Subscribes to queue-size changes broadcast by the service worker
 * (`srs-queue-updated`) so UI (e.g. the offline indicator badge) can stay
 * live without polling. Returns an unsubscribe function.
 */
export function subscribeToQueueUpdates(listener: QueueUpdateListener): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return () => {};
  }
  const handler = (event: MessageEvent) => {
    if (event.data && event.data.type === "srs-queue-updated") {
      listener(event.data.count ?? 0);
    }
  };
  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}
