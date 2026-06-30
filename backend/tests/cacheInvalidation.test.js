/**
 * Cache invalidation tests for #399
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import { CacheManager, setCacheManagerForTests } from "../src/cache.js";
import { AdminEventListener } from "../src/events/adminEventListener.js";

// Mock logger to avoid console noise in tests
jest.mock("../src/logger.js", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

class MemoryCache {
  constructor() {
    this.store = new Map();
  }

  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async set(key, value) {
    this.store.set(key, value);
  }

  async invalidate(key) {
    return this.store.delete(key);
  }

  async invalidateAdmin() {
    const result = await this.invalidate(CacheManager.KEYS.ADMIN);
    await this.invalidate(CacheManager.KEYS.HEALTH);
    return result;
  }

  async flushAll() {
    this.store.clear();
  }

  async verifyAdminConsistency(fetchLiveAdmin) {
    const cachedAdmin = await this.get(CacheManager.KEYS.ADMIN);
    const liveAdmin = await fetchLiveAdmin();
    const consistent = cachedAdmin === liveAdmin;
    if (!consistent && cachedAdmin !== null) {
      await this.set(CacheManager.KEYS.ADMIN, liveAdmin);
    }
    return { consistent, cachedAdmin, liveAdmin, elapsedMs: 0 };
  }

  async disconnect() {
    this.store.clear();
  }
}

// Mock Soroban RPC
class MockSorobanRpc {
  constructor() {
    this.admin = "GOLDADMIN123";
    this.events = [];
    this.ledger = 1000;
  }

  async getContractAdmin() {
    return this.admin;
  }

  async getEvents() {
    return { events: this.events };
  }

  async getHealth() {
    return { status: "healthy" };
  }

  async submitTransaction(xdr) {
    return { status: "SUCCESS", hash: "txhash123" };
  }

  setAdmin(newAdmin) {
    this.admin = newAdmin;
  }

  emitAdminTransfer(previousAdmin, newAdmin) {
    this.ledger++;
    this.events.push({
      ledgerSequence: this.ledger,
      transactionHash: `tx${this.ledger}`,
      eventIndex: 0,
      topic: [
        Buffer.from("royalty").toString("base64"),
        Buffer.from("admin_xfr").toString("base64"),
      ],
      value: Buffer.from(
        JSON.stringify({ previousAdmin, newAdmin })
      ).toString("base64"),
      timestamp: new Date().toISOString(),
    });
  }

  emitAcceptAdmin(previousAdmin, newAdmin) {
    this.ledger++;
    this.events.push({
      ledgerSequence: this.ledger,
      transactionHash: `tx${this.ledger}`,
      eventIndex: 0,
      topic: [
        Buffer.from("royalty").toString("base64"),
        Buffer.from("adm_acc").toString("base64"),
      ],
      value: Buffer.from(
        JSON.stringify({ previousAdmin, newAdmin })
      ).toString("base64"),
      timestamp: new Date().toISOString(),
    });
  }
}

describe("Cache Invalidation (#399)", () => {
  let cache;
  let rpc;
  let listener;
  const contractId = "C123TEST";

  beforeAll(async () => {
    cache = new MemoryCache();
    setCacheManagerForTests(cache);
    rpc = new MockSorobanRpc();
  });

  beforeEach(async () => {
    await cache.flushAll();
    rpc.events = [];
    rpc.ledger = 1000;
  });

  afterAll(async () => {
    await cache.disconnect();
    if (listener) listener.stop();
  });

  // Test 1: Immediate cache invalidation on admin transfer
  it("should invalidate admin cache immediately after transfer", async () => {
    await cache.set(CacheManager.KEYS.ADMIN, "GOLDADMIN123");
    expect(await cache.get(CacheManager.KEYS.ADMIN)).toBe("GOLDADMIN123");

    rpc.setAdmin("GNEWADMIN456");
    await cache.invalidateAdmin();

    const cached = await cache.get(CacheManager.KEYS.ADMIN);
    expect(cached).toBeNull();
  });

  // Test 2: Health endpoint reflects new admin within 100ms
  it("should return updated admin in health check within 100ms", async () => {
    await cache.set(CacheManager.KEYS.ADMIN, "GOLDADMIN123");
    rpc.setAdmin("GNEWADMIN456");

    const start = Date.now();
    const result = await cache.verifyAdminConsistency(() => rpc.getContractAdmin());
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(result.consistent).toBe(false); // Was stale
    expect(result.liveAdmin).toBe("GNEWADMIN456");
    expect(await cache.get(CacheManager.KEYS.ADMIN)).toBe("GNEWADMIN456");
  });

  // Test 3: No stale admin addresses returned during concurrent requests
  it("should not return stale admin under concurrent load", async () => {
    const NEW_ADMIN = "GCONCURRENT789";

    await cache.set(CacheManager.KEYS.ADMIN, "GOLDADMIN123");
    rpc.setAdmin(NEW_ADMIN);
    await cache.invalidateAdmin();

    // Simulate 100 concurrent reads immediately after admin transfer invalidation.
    const promises = Array.from({ length: 100 }, async (_, i) => {
      await new Promise((r) => setTimeout(r, Math.random() * 10));

      const admin = await cache.get(CacheManager.KEYS.ADMIN);

      // If cache has been invalidated, fetch from "chain"
      if (admin === null) {
        return rpc.getContractAdmin();
      }
      return admin;
    });

    const results = await Promise.all(promises);

    // After invalidation, no stale addresses should persist
    const uniqueAdmins = [...new Set(results)];
    expect(uniqueAdmins).toContain(NEW_ADMIN);
    expect(uniqueAdmins).not.toContain("GOLDADMIN123");
  });

  // Test 4: Event listener detects admin transfer and invalidates cache
  it("should detect admin transfer event and invalidate cache", async () => {
    await cache.set(CacheManager.KEYS.ADMIN, "GOLDADMIN123");

    listener = new AdminEventListener(rpc, contractId);
    listener.cache = cache;

    rpc.emitAdminTransfer("GOLDADMIN123", "GEVENTADMIN999");

    await listener._checkForEvents();

    const cached = await cache.get(CacheManager.KEYS.ADMIN);
    expect(cached).toBeNull();
  });

  // Test 5: Webhook delivery unaffected by cache changes
  it("should preserve webhook functionality after cache invalidation", async () => {
    await cache.set("webhook:deliveries", { count: 42, lastDelivery: "2024-01-01" });
    await cache.set(CacheManager.KEYS.ADMIN, "GOLDADMIN123");

    await cache.invalidateAdmin();

    const webhookData = await cache.get("webhook:deliveries");
    expect(webhookData).toEqual({ count: 42, lastDelivery: "2024-01-01" });
  });

  // Test 6: Event deduplication — same event not processed twice
  it("should deduplicate admin transfer events", async () => {
    await cache.set(CacheManager.KEYS.ADMIN, "GOLDADMIN123");

    listener = new AdminEventListener(rpc, contractId);
    listener.cache = cache;

    rpc.emitAdminTransfer("GOLDADMIN123", "GDUPADMIN111");
    rpc.events.push({ ...rpc.events[0] }); // duplicate event id

    await listener._checkForEvents();

    expect(listener.processedEvents.size).toBe(1);
  });

  // Test 7: accept_admin event also triggers invalidation
  it("should invalidate cache on accept_admin event", async () => {
    await cache.set(CacheManager.KEYS.ADMIN, "GOLDADMIN123");

    listener = new AdminEventListener(rpc, contractId);
    listener.cache = cache;

    rpc.emitAcceptAdmin("GOLDADMIN123", "GACCEPTEDADMIN222");

    await listener._checkForEvents();

    const cached = await cache.get(CacheManager.KEYS.ADMIN);
    expect(cached).toBeNull();
  });

  // Test 8: Health cache is invalidated alongside admin cache
  it("should invalidate health cache when admin cache is invalidated", async () => {
    await cache.set(CacheManager.KEYS.ADMIN, "GOLDADMIN123");
    await cache.set(CacheManager.KEYS.HEALTH, { ok: true, admin: "GOLDADMIN123" });

    await cache.invalidateAdmin();

    const healthCached = await cache.get(CacheManager.KEYS.HEALTH);
    expect(healthCached).toBeNull();
  });
});
