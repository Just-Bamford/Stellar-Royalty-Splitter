/**
 * Tests for the offline write queue's main-thread interface (#771):
 * persistence across "reloads" (fresh DB connections), the manual clear
 * action, and the exponential backoff math used by the service worker.
 */

import { describe, test, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import {
  getQueuedWrites,
  getQueueCount,
  clearQueue,
  computeBackoffMs,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  QUEUE_DB_NAME,
  QUEUE_STORE_NAME,
} from "./offlineQueue";

function seedQueueItem(overrides: Partial<Record<string, unknown>> = {}) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(QUEUE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE_NAME)) {
        db.createObjectStore(QUEUE_STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(QUEUE_STORE_NAME, "readwrite");
      tx.objectStore(QUEUE_STORE_NAME).add({
        url: "/api/v1/preferences",
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentMethod: "usdc" }),
        attempts: 0,
        nextRetryAt: Date.now(),
        queuedAt: Date.now(),
        ...overrides,
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

describe("offline write queue (#771)", () => {
  beforeEach(() => {
    // fake-indexeddb keeps state across tests unless reset.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).indexedDB = new IDBFactory();
  });

  test("getQueueCount is 0 with no queued writes", async () => {
    expect(await getQueueCount()).toBe(0);
  });

  test("queued writes persist across fresh DB connections (simulated reload)", async () => {
    await seedQueueItem({ url: "/api/v1/preferences" });
    await seedQueueItem({ url: "/api/v1/notifications" });

    expect(await getQueueCount()).toBe(2);

    const writes = await getQueuedWrites();
    expect(writes.map((w) => w.url)).toEqual([
      "/api/v1/preferences",
      "/api/v1/notifications",
    ]);
  });

  test("returns queued writes oldest first", async () => {
    await seedQueueItem({ url: "/api/v1/second", queuedAt: 2000 });
    await seedQueueItem({ url: "/api/v1/first", queuedAt: 1000 });

    const writes = await getQueuedWrites();
    expect(writes.map((w) => w.url)).toEqual(["/api/v1/first", "/api/v1/second"]);
  });

  test("clearQueue removes every pending write", async () => {
    await seedQueueItem();
    await seedQueueItem();
    expect(await getQueueCount()).toBe(2);

    await clearQueue();

    expect(await getQueueCount()).toBe(0);
    expect(await getQueuedWrites()).toEqual([]);
  });

  test("getQueuedWrites resolves to an empty array when IndexedDB is unavailable", async () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error simulating an environment without IndexedDB
    delete globalThis.indexedDB;

    expect(await getQueuedWrites()).toEqual([]);
    expect(await getQueueCount()).toBe(0);

    globalThis.indexedDB = original;
  });
});

describe("computeBackoffMs (#771)", () => {
  test("starts at the base delay for the first retry", () => {
    expect(computeBackoffMs(0)).toBe(BASE_BACKOFF_MS);
  });

  test("doubles with each attempt", () => {
    expect(computeBackoffMs(1)).toBe(BASE_BACKOFF_MS * 2);
    expect(computeBackoffMs(2)).toBe(BASE_BACKOFF_MS * 4);
    expect(computeBackoffMs(3)).toBe(BASE_BACKOFF_MS * 8);
  });

  test("caps at MAX_BACKOFF_MS (10 minutes) no matter how many attempts", () => {
    expect(computeBackoffMs(20)).toBe(MAX_BACKOFF_MS);
    expect(computeBackoffMs(100)).toBe(MAX_BACKOFF_MS);
  });
});
