/**
 * Tests for the Redis-backed cache client (#926).
 *
 * Uses ioredis-mock in place of a real Redis server (injected via the
 * RedisImpl constructor option) so these tests run without any external
 * infrastructure. Two independently-constructed RedisCacheClient instances
 * sharing the same mock backend are used to approximate the "two backend
 * instances share a cache" E2E scenario that cannot be verified in this
 * sandboxed environment without a second real process + real Redis server.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import RedisMock from "ioredis-mock";
import { RedisCacheClient, namespacedKey, REDIS_TTL_MS, KEY_PREFIX } from "../src/cache-redis.js";

// ioredis-mock instances backed by the same "shared" in-memory key space
// when constructed against the same connection string, matching how real
// ioredis clients pointed at the same REDIS_URL would share state.
const SHARED_URL = "redis://shared-mock:6379";

function makeClient(overrides = {}) {
  return new RedisCacheClient({
    url: SHARED_URL,
    RedisImpl: RedisMock,
    ...overrides,
  });
}

describe("namespacedKey", () => {
  test("builds srs:<resourceType>:<...parts> keys", () => {
    expect(namespacedKey("contract", "C123", "state")).toBe("srs:contract:C123:state");
    expect(namespacedKey("collaborator", "C123")).toBe("srs:collaborator:C123");
  });

  test("KEY_PREFIX matches the required 'srs:' namespace", () => {
    expect(KEY_PREFIX).toBe("srs:");
  });
});

describe("REDIS_TTL_MS", () => {
  test("matches the durations specified in #926", () => {
    expect(REDIS_TTL_MS.contractState).toBe(5 * 60 * 1000);
    expect(REDIS_TTL_MS.analytics).toBe(60 * 60 * 1000);
    expect(REDIS_TTL_MS.collaborator).toBe(30 * 60 * 1000);
    expect(REDIS_TTL_MS.session).toBe(24 * 60 * 60 * 1000);
  });
});

describe("RedisCacheClient — no REDIS_URL configured", () => {
  test("is disabled and every method resolves to a safe fallback without throwing", async () => {
    const client = new RedisCacheClient({ url: undefined, RedisImpl: RedisMock });

    expect(client.available).toBe(false);
    await expect(client.connect()).resolves.toBe(false);
    await expect(client.get("srs:contract:x")).resolves.toBeUndefined();
    await expect(client.set("srs:contract:x", { a: 1 }, 1000)).resolves.toBe(false);
    await expect(client.delete("srs:contract:x")).resolves.toBe(false);
    await expect(client.deleteByPrefix("srs:contract:")).resolves.toBe(0);
    await expect(client.publishInvalidation({ key: "srs:contract:x" })).resolves.toBe(false);
    await expect(client.subscribeToInvalidation(() => {})).resolves.toBe(false);
    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe("RedisCacheClient — get/set/delete/TTL", () => {
  let client;

  beforeEach(async () => {
    client = makeClient();
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
  });

  test("connect() resolves true and marks the client available", async () => {
    expect(client.available).toBe(true);
  });

  test("set() then get() round-trips a JSON-serializable value", async () => {
    const key = namespacedKey("contract", "C1", "state");
    const value = { contractId: "C1", royaltyRate: 500, recipients: [{ address: "G1", basisPoints: 10000 }] };

    const setResult = await client.set(key, value, REDIS_TTL_MS.contractState);
    expect(setResult).toBe(true);

    const got = await client.get(key);
    expect(got).toEqual(value);
  });

  test("get() returns undefined for a missing key", async () => {
    await expect(client.get(namespacedKey("contract", "does-not-exist"))).resolves.toBeUndefined();
  });

  test("delete() removes a key so a subsequent get() misses", async () => {
    const key = namespacedKey("analytics", "C1", "daily");
    await client.set(key, { total: 42 }, REDIS_TTL_MS.analytics);
    expect(await client.get(key)).toEqual({ total: 42 });

    const deleted = await client.delete(key);
    expect(deleted).toBe(true);
    expect(await client.get(key)).toBeUndefined();
  });

  test("delete() returns false for a key that does not exist", async () => {
    await expect(client.delete(namespacedKey("session", "nope"))).resolves.toBe(false);
  });

  test("TTL expiry: a key set with a short TTL is gone after it elapses", async () => {
    const key = namespacedKey("collaborator", "C1");
    await client.set(key, { data: true }, 20);
    expect(await client.get(key)).toEqual({ data: true });

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(await client.get(key)).toBeUndefined();
  });

  test("set() without a TTL persists the key (no expiry)", async () => {
    const key = namespacedKey("collaborator", "no-ttl");
    await client.set(key, { persisted: true });
    expect(await client.get(key)).toEqual({ persisted: true });
  });

  test("deleteByPrefix() removes every key under a prefix and leaves others intact", async () => {
    await client.set(namespacedKey("collaborators", "C1"), { a: 1 });
    await client.set(namespacedKey("collaborators", "C2"), { a: 2 });
    await client.set(namespacedKey("contractState", "C1", "TOK"), { b: 1 });

    const deleted = await client.deleteByPrefix(`${KEY_PREFIX}collaborators`);
    expect(deleted).toBe(2);

    expect(await client.get(namespacedKey("collaborators", "C1"))).toBeUndefined();
    expect(await client.get(namespacedKey("collaborators", "C2"))).toBeUndefined();
    // A different resource-type prefix must be untouched.
    expect(await client.get(namespacedKey("contractState", "C1", "TOK"))).toEqual({ b: 1 });
  });
});

describe("RedisCacheClient — graceful fallback on connection failure", () => {
  // ioredis-mock assigns `connect` as an own instance property in its own
  // constructor (not a prototype method), so a subclass's prototype-level
  // `connect() {}` override is shadowed and never actually called. Building
  // a real instance and then reassigning the own `connect` property is the
  // only way to make it reject, and matches how the RedisImpl option is
  // actually used (as a constructor, not a class to extend).
  function ThrowingRedis(...args) {
    const instance = new RedisMock(...args);
    instance.connect = () => Promise.reject(new Error("ECONNREFUSED simulated"));
    return instance;
  }

  test("connect() resolves false (never rejects) when the underlying client throws", async () => {
    const client = new RedisCacheClient({ url: SHARED_URL, RedisImpl: ThrowingRedis });

    await expect(client.connect()).resolves.toBe(false);
    expect(client.available).toBe(false);
  });

  test("get()/set() never throw even when the client is unavailable after a failed connect", async () => {
    const client = new RedisCacheClient({ url: SHARED_URL, RedisImpl: ThrowingRedis });
    await client.connect();

    // get/set still route through the (unavailable) client rather than
    // throwing; ioredis itself would reject these calls, which the wrapper
    // must catch internally.
    await expect(client.get("srs:contract:x")).resolves.toBeUndefined();
    await expect(client.set("srs:contract:x", { a: 1 })).resolves.toBe(false);
  });

  test("a client constructor error does not throw synchronously", () => {
    class BrokenRedis {
      constructor() {
        throw new Error("bad connection string");
      }
    }

    expect(() => new RedisCacheClient({ url: SHARED_URL, RedisImpl: BrokenRedis })).not.toThrow();
  });

  test("an unhandled 'error' event from the underlying client does not crash the process", async () => {
    const client = makeClient();
    await client.connect();

    // Simulate what ioredis does on every failed reconnect attempt: emit
    // 'error'. Without a listener attached, Node treats this as an
    // unhandled error and crashes the process — RedisCacheClient's
    // constructor always attaches one.
    expect(() => client.client.emit("error", new Error("simulated redis error"))).not.toThrow();
    expect(client.available).toBe(false);

    await client.close();
  });
});

describe("RedisCacheClient — two instances sharing the same Redis backend", () => {
  // This is the closest local proxy for the "2 backend instances share
  // cache" E2E acceptance criterion: two independently-constructed
  // RedisCacheClient objects (standing in for two backend processes), both
  // pointed at the same underlying Redis connection string, must see each
  // other's writes and deletes.
  let instanceA;
  let instanceB;

  beforeEach(async () => {
    instanceA = makeClient();
    instanceB = makeClient();
    await instanceA.connect();
    await instanceB.connect();
  });

  afterEach(async () => {
    await instanceA.close();
    await instanceB.close();
  });

  test("a set() on instance A is visible via get() on instance B", async () => {
    const key = namespacedKey("contract", "SHARED_CONTRACT", "state");
    const value = { contractId: "SHARED_CONTRACT", royaltyRate: 750 };

    await instanceA.set(key, value, REDIS_TTL_MS.contractState);

    const seenByB = await instanceB.get(key);
    expect(seenByB).toEqual(value);
  });

  test("a delete() on instance B is visible (as a miss) via get() on instance A", async () => {
    const key = namespacedKey("collaborators", "SHARED_CONTRACT");
    await instanceA.set(key, [{ address: "G1", basisPoints: 5000 }]);
    expect(await instanceB.get(key)).toBeDefined();

    await instanceB.delete(key);

    expect(await instanceA.get(key)).toBeUndefined();
  });
});

describe("RedisCacheClient — pub/sub invalidation", () => {
  let publisher;
  let subscriber;

  beforeEach(async () => {
    publisher = makeClient();
    subscriber = makeClient();
    await publisher.connect();
    await subscriber.connect();
  });

  afterEach(async () => {
    await publisher.close();
    await subscriber.close();
  });

  test("subscribeToInvalidation() receives a message published by another instance", async () => {
    const handler = jest.fn();
    await subscriber.subscribeToInvalidation(handler);

    await publisher.publishInvalidation({ key: "srs:contractState:C1:TOK", reason: "distribute" });

    // pub/sub delivery is async even against the in-memory mock.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalledWith({
      key: "srs:contractState:C1:TOK",
      reason: "distribute",
    });
  });

  test("a prefix invalidation message is delivered with its prefix intact", async () => {
    const handler = jest.fn();
    await subscriber.subscribeToInvalidation(handler);

    await publisher.publishInvalidation({ prefix: "srs:collaborators:C1", reason: "admin_action" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalledWith({
      prefix: "srs:collaborators:C1",
      reason: "admin_action",
    });
  });

  test("multiple handlers registered on the same client all receive the message", async () => {
    const handlerA = jest.fn();
    const handlerB = jest.fn();
    await subscriber.subscribeToInvalidation(handlerA);
    await subscriber.subscribeToInvalidation(handlerB);

    await publisher.publishInvalidation({ key: "srs:session:tok1" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  test("a handler that throws does not prevent other handlers from running", async () => {
    const throwing = jest.fn(() => {
      throw new Error("boom");
    });
    const fine = jest.fn();
    await subscriber.subscribeToInvalidation(throwing);
    await subscriber.subscribeToInvalidation(fine);

    await publisher.publishInvalidation({ key: "srs:session:tok2" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(fine).toHaveBeenCalledTimes(1);
  });
});
