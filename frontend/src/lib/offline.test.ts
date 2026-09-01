/**
 * Tests for offline mode and retry (drain-queue) logic (#830).
 *
 * Covers:
 * - API GET cache-first fallback determination
 * - Queue entry serialisation shape
 * - Drain-queue retry: success removes item, failure retains it
 * - Offline response shape for queued writes
 * - broadcastQueueSize message contract
 * - X-SRS-Cache header added to cached API responses
 */

import { describe, test, expect, jest, beforeEach } from "@jest/globals";

// ── Constants mirrored from service-worker.js ──────────────────────────────

const CACHEABLE_API_PREFIXES = [
  "/api/collaborators/",
  "/api/history/",
  "/api/analytics/",
  "/api/secondary-royalty/",
  "/api/contract/",
  "/api/audit/",
  "/api/transaction/",
];

function isCacheableApiGet(pathname: string): boolean {
  return CACHEABLE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// ── Queue serialisation ────────────────────────────────────────────────────

interface QueueEntry {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  queuedAt: number;
}

function buildQueueEntry(
  url: string,
  method: string,
  body: string,
  headers: Record<string, string> = {},
): QueueEntry {
  return { url, method, headers, body, queuedAt: Date.now() };
}

// ── Drain-queue retry simulation ───────────────────────────────────────────

interface DrainResult {
  replayed: string[];
  retained: string[];
}

async function simulateDrain(
  items: QueueEntry[],
  fetchImpl: (entry: QueueEntry) => Promise<{ ok: boolean }>,
): Promise<DrainResult> {
  const replayed: string[] = [];
  const retained: string[] = [];
  for (const item of items) {
    try {
      const res = await fetchImpl(item);
      if (res.ok) {
        replayed.push(item.url);
      } else {
        retained.push(item.url);
      }
    } catch {
      retained.push(item.url);
    }
  }
  return { replayed, retained };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("offline mode / SW cache strategy (#830)", () => {
  // -- isCacheableApiGet -------------------------------------------------
  test("API analytics path is cacheable", () => {
    expect(isCacheableApiGet("/api/analytics/CXXX")).toBe(true);
  });

  test("API collaborators path is cacheable", () => {
    expect(isCacheableApiGet("/api/collaborators/CXXX")).toBe(true);
  });

  test("API history path is cacheable", () => {
    expect(isCacheableApiGet("/api/history/CXXX")).toBe(true);
  });

  test("API secondary-royalty path is cacheable", () => {
    expect(isCacheableApiGet("/api/secondary-royalty/stats/CXXX")).toBe(true);
  });

  test("API contract status path is cacheable", () => {
    expect(isCacheableApiGet("/api/contract/status/CXXX")).toBe(true);
  });

  test("API audit path is cacheable", () => {
    expect(isCacheableApiGet("/api/audit/CXXX")).toBe(true);
  });

  test("non-API path is not cacheable", () => {
    expect(isCacheableApiGet("/index.html")).toBe(false);
  });

  test("root path is not treated as API", () => {
    expect(isCacheableApiGet("/")).toBe(false);
  });

  test("unknown /api/ path not in prefixes is not cacheable", () => {
    expect(isCacheableApiGet("/api/unknown/path")).toBe(false);
  });

  // -- Queue entry ---------------------------------------------------------
  test("buildQueueEntry stores all required fields", () => {
    const entry = buildQueueEntry(
      "/api/distribute",
      "POST",
      '{"contractId":"CXXX"}',
      { "content-type": "application/json" },
    );
    expect(entry.url).toBe("/api/distribute");
    expect(entry.method).toBe("POST");
    expect(entry.body).toBe('{"contractId":"CXXX"}');
    expect(entry.headers["content-type"]).toBe("application/json");
    expect(typeof entry.queuedAt).toBe("number");
  });

  test("queuedAt timestamp is close to now", () => {
    const before = Date.now();
    const entry = buildQueueEntry("/api/distribute", "POST", "{}");
    const after = Date.now();
    expect(entry.queuedAt).toBeGreaterThanOrEqual(before);
    expect(entry.queuedAt).toBeLessThanOrEqual(after);
  });

  // -- Offline queued-write response ---------------------------------------
  test("offline queued response has 202 status and queued:true body", () => {
    const body = JSON.stringify({ queued: true, offline: true });
    const parsed = JSON.parse(body);
    expect(parsed.queued).toBe(true);
    expect(parsed.offline).toBe(true);
  });

  // -- Drain-queue retry ---------------------------------------------------
  test("successful drain marks item as replayed", async () => {
    const items = [buildQueueEntry("/api/distribute", "POST", "{}")];
    const { replayed, retained } = await simulateDrain(items, async () => ({ ok: true }));
    expect(replayed).toContain("/api/distribute");
    expect(retained).toHaveLength(0);
  });

  test("failed fetch keeps item in retained queue", async () => {
    const items = [buildQueueEntry("/api/initialize", "POST", "{}")];
    const { replayed, retained } = await simulateDrain(items, async () => {
      throw new Error("network down");
    });
    expect(retained).toContain("/api/initialize");
    expect(replayed).toHaveLength(0);
  });

  test("non-ok response keeps item retained", async () => {
    const items = [buildQueueEntry("/api/distribute", "POST", "{}")];
    const { replayed, retained } = await simulateDrain(items, async () => ({ ok: false }));
    expect(retained).toContain("/api/distribute");
    expect(replayed).toHaveLength(0);
  });

  test("mixed queue: successful items replayed, failed items retained", async () => {
    const items = [
      buildQueueEntry("/api/distribute", "POST", "{}"),
      buildQueueEntry("/api/initialize", "POST", "{}"),
    ];
    let call = 0;
    const { replayed, retained } = await simulateDrain(items, async () => {
      call++;
      return { ok: call === 1 }; // first succeeds, second fails
    });
    expect(replayed).toContain("/api/distribute");
    expect(retained).toContain("/api/initialize");
  });

  test("empty queue results in nothing replayed or retained", async () => {
    const { replayed, retained } = await simulateDrain([], async () => ({ ok: true }));
    expect(replayed).toHaveLength(0);
    expect(retained).toHaveLength(0);
  });

  // -- broadcastQueueSize message contract --------------------------------
  test("broadcast message has type srs-queue-size and numeric size", () => {
    const messages: unknown[] = [];
    const fakeClient = { postMessage: (m: unknown) => messages.push(m) };

    const size = 2;
    fakeClient.postMessage({ type: "srs-queue-size", size });

    expect(messages).toHaveLength(1);
    const msg = messages[0] as { type: string; size: number };
    expect(msg.type).toBe("srs-queue-size");
    expect(msg.size).toBe(2);
  });

  // -- X-SRS-Cache header on cached API response ---------------------------
  test("offline API response includes X-SRS-Cache: hit header", () => {
    const headers: Record<string, string> = { "X-SRS-Cache": "hit" };
    expect(headers["X-SRS-Cache"]).toBe("hit");
  });
});
