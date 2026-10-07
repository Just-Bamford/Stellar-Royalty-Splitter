import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import {
  clearCache,
  createDeduplicationKey,
  deduplicationMiddleware,
  dedupMetrics,
  getDedupMetrics,
  getInFlightRequestCount,
  idempotencyMiddleware,
} from "../src/idempotency.js";

function makeRequest(idempotencyKey) {
  return {
    headers: { "idempotency-key": idempotencyKey },
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    _body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("in-flight idempotency deduplication", () => {
  beforeEach(() => {
    clearCache();
    dedupMetrics.hits = 0;
    dedupMetrics.misses = 0;
  });

  afterEach(() => {
    clearCache();
    jest.useRealTimers();
  });

  test("creates a deterministic key from operation and idempotency key", () => {
    const key = createDeduplicationKey("distribute", "request-1");

    expect(key).toHaveLength(64);
    expect(key).toBe(createDeduplicationKey("distribute", "request-1"));
    expect(key).not.toBe(createDeduplicationKey("initialize", "request-1"));
    expect(key).not.toBe(createDeduplicationKey("distribute", "request-2"));
  });

  test("two concurrent identical requests execute once and share the original result", async () => {
    const firstResponse = makeResponse();
    const secondResponse = makeResponse();
    const firstNext = jest.fn();
    const secondNext = jest.fn();

    idempotencyMiddleware(makeRequest("same-request"), firstResponse, firstNext);
    idempotencyMiddleware(makeRequest("same-request"), secondResponse, secondNext);

    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(secondNext).not.toHaveBeenCalled();
    expect(getInFlightRequestCount()).toBe(1);

    firstResponse.status(201).json({ transactionId: "tx-original" });
    await flushPromises();

    expect(secondResponse.statusCode).toBe(201);
    expect(secondResponse._body).toEqual({ transactionId: "tx-original" });
    expect(getInFlightRequestCount()).toBe(0);
    expect(getDedupMetrics()).toMatchObject({ hits: 1, misses: 1 });
  });

  test("different operation names do not share an in-flight result", async () => {
    const firstResponse = makeResponse();
    const secondResponse = makeResponse();
    const firstNext = jest.fn();
    const secondNext = jest.fn();

    deduplicationMiddleware("distribute")(makeRequest("same-request"), firstResponse, firstNext);
    deduplicationMiddleware("initialize")(makeRequest("same-request"), secondResponse, secondNext);

    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(secondNext).toHaveBeenCalledTimes(1);
    expect(getInFlightRequestCount()).toBe(2);

    firstResponse.json({ operation: "distribute" });
    secondResponse.json({ operation: "initialize" });
    await flushPromises();

    expect(getInFlightRequestCount()).toBe(0);
  });

  test("failed responses clean up the entry and allow a later retry", () => {
    const firstResponse = makeResponse();
    const firstNext = jest.fn();
    idempotencyMiddleware(makeRequest("failed-request"), firstResponse, firstNext);

    firstResponse.status(500).json({ error: "failed" });
    expect(getInFlightRequestCount()).toBe(0);

    const retryNext = jest.fn();
    const retryResponse = makeResponse();
    idempotencyMiddleware(makeRequest("failed-request"), retryResponse, retryNext);

    expect(retryNext).toHaveBeenCalledTimes(1);
    retryResponse.json({ ok: true });
  });

  test("stale entries expire and an old completion cannot remove a newer entry", async () => {
    jest.useFakeTimers();

    const firstResponse = makeResponse();
    const firstNext = jest.fn();
    const dedup = deduplicationMiddleware("distribute");
    dedup(makeRequest("race-request"), firstResponse, firstNext);

    const waitingResponse = makeResponse();
    const waitingNext = jest.fn();
    dedup(makeRequest("race-request"), waitingResponse, waitingNext);

    jest.advanceTimersByTime(10_000);
    await flushPromises();

    expect(waitingResponse.statusCode).toBe(503);
    expect(waitingNext).not.toHaveBeenCalled();
    expect(getInFlightRequestCount()).toBe(0);

    const newerResponse = makeResponse();
    const newerNext = jest.fn();
    dedup(makeRequest("race-request"), newerResponse, newerNext);
    expect(newerNext).toHaveBeenCalledTimes(1);
    expect(getInFlightRequestCount()).toBe(1);

    // This is the late completion of the expired request. It must not delete
    // the newer request that now owns the same deterministic key.
    firstResponse.json({ result: "old" });
    expect(getInFlightRequestCount()).toBe(1);

    newerResponse.json({ result: "new" });
    expect(getInFlightRequestCount()).toBe(0);
  });
});
