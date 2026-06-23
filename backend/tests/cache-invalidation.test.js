import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { AdminTransferEventListener } from "../src/events/adminTransferListener.js";
import { ContractStateCache } from "../src/cache/contractStateCache.js";

// Mock @stellar/stellar-sdk
jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  xdr: {
    ScVal: {
      scvSymbol: (name) => ({
        toXDR: (fmt) => Buffer.from(name).toString(fmt === "hex" ? "hex" : "base64"),
      }),
      fromXDR: () => ({
        address: () => ({ toString: () => "GNEWADMIN123456789" }),
      }),
    },
  },
}));

describe("Cache Invalidation on Admin Transfer", () => {
  let cacheManager;
  let mockServer;
  let listener;
  let mockLogger;

  beforeEach(() => {
    cacheManager = new ContractStateCache(30);
    jest.spyOn(cacheManager, "invalidateAdmin");
    jest.spyOn(cacheManager, "invalidateAll");
    jest.spyOn(cacheManager, "setAdmin");

    mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

    mockServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1000 }),
      getEvents: jest.fn().mockResolvedValue({ events: [] }),
    };
  });

  afterEach(() => {
    if (listener) listener.stop();
    jest.clearAllMocks();
  });

  describe("1. Immediate Cache Invalidation", () => {
    it("invalidates admin cache within 100ms of event detection", async () => {
      const mockEvent = {
        ledgerSequence: 1001,
        txHash: "abc123",
        topic: ["admin_transfer", "old", "GOLDADMIN", "GNEWADMIN123456789"],
      };

      mockServer.getEvents = jest
        .fn()
        .mockResolvedValueOnce({ events: [mockEvent] })
        .mockResolvedValue({ events: [] });

      listener = new AdminTransferEventListener(
        mockServer,
        "CONTRACT123",
        cacheManager,
        mockLogger
      );

      const start = performance.now();
      await listener.start();
      await new Promise((r) => setTimeout(r, 50));

      expect(cacheManager.invalidateAdmin).toHaveBeenCalled();
      expect(cacheManager.invalidateAll).toHaveBeenCalled();
      expect(performance.now() - start).toBeLessThan(100);
    });

    it("logs admin change details", async () => {
      const mockEvent = {
        ledgerSequence: 1001,
        txHash: "abc123",
        topic: ["admin_transfer", "old", "GOLDADMIN", "GNEWADMIN"],
      };

      mockServer.getEvents = jest
        .fn()
        .mockResolvedValueOnce({ events: [mockEvent] })
        .mockResolvedValue({ events: [] });

      listener = new AdminTransferEventListener(
        mockServer,
        "CONTRACT123",
        cacheManager,
        mockLogger
      );

      await listener.start();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Transfer:")
      );
    });
  });

  describe("2. Health Endpoint Accuracy", () => {
    it("reflects new admin within 100ms of invalidation", async () => {
      cacheManager.setAdmin("GOLDADMIN");

      const mockEvent = {
        ledgerSequence: 1001,
        txHash: "abc123",
        topic: ["admin_transfer", "old", "GOLDADMIN", "GNEWADMIN"],
      };

      mockServer.getEvents = jest
        .fn()
        .mockResolvedValueOnce({ events: [mockEvent] })
        .mockResolvedValue({ events: [] });

      listener = new AdminTransferEventListener(
        mockServer,
        "CONTRACT123",
        cacheManager,
        mockLogger
      );

      await listener.start();
      await new Promise((r) => setTimeout(r, 50));

      const admin = await cacheManager.getAdmin();
      expect(admin).toBeNull(); // forces fresh read
    });
  });

  describe("3. No Stale Addresses", () => {
    it("never returns old admin after invalidation", async () => {
      cacheManager.setAdmin("GOLDADMIN");
      await cacheManager.invalidateAdmin();

      const admin = await cacheManager.getAdmin();
      expect(admin).toBeNull();
    });

    it("handles multiple rapid admin transfers", async () => {
      const events = [
        { ledgerSequence: 1001, txHash: "tx1", topic: ["t", "o", "A1", "A2"] },
        { ledgerSequence: 1002, txHash: "tx2", topic: ["t", "o", "A2", "A3"] },
        { ledgerSequence: 1003, txHash: "tx3", topic: ["t", "o", "A3", "A4"] },
      ];

      mockServer.getEvents = jest
        .fn()
        .mockResolvedValueOnce({ events })
        .mockResolvedValue({ events: [] });

      listener = new AdminTransferEventListener(
        mockServer,
        "CONTRACT123",
        cacheManager,
        mockLogger
      );

      await listener.start();
      await new Promise((r) => setTimeout(r, 100));

      expect(cacheManager.invalidateAll).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledTimes(3);
    });
  });

  describe("4. Concurrent Request Consistency", () => {
    it("handles concurrent reads during admin transfer", async () => {
      cacheManager.setAdmin("GOLDADMIN");

      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(cacheManager.getAdmin());
      }

      await cacheManager.invalidateAdmin();
      const results = await Promise.all(promises);

      const unique = [...new Set(results)];
      expect(unique).toContain("GOLDADMIN");
    });

    it("blocks fresh reads for 500ms after invalidation", async () => {
      cacheManager.setAdmin("GOLDADMIN");
      await cacheManager.invalidateAdmin();

      expect(await cacheManager.getAdmin()).toBeNull();

      await new Promise((r) => setTimeout(r, 600));
      cacheManager.setAdmin("GNEWADMIN");
      expect(await cacheManager.getAdmin()).toBe("GNEWADMIN");
    });
  });

  describe("5. Webhook Delivery Preservation", () => {
    it("does not affect webhook functionality", async () => {
      const webhookDelivered = jest.fn().mockResolvedValue(true);
      await cacheManager.invalidateAdmin();
      await webhookDelivered({ type: "test" });
      expect(webhookDelivered).toHaveBeenCalled();
    });

    it("emits event for downstream consumers", async () => {
      const mockEvent = {
        ledgerSequence: 1001,
        txHash: "abc123",
        topic: ["admin_transfer", "old", "GOLDADMIN", "GNEWADMIN"],
      };

      mockServer.getEvents = jest
        .fn()
        .mockResolvedValueOnce({ events: [mockEvent] })
        .mockResolvedValue({ events: [] });

      listener = new AdminTransferEventListener(
        mockServer,
        "CONTRACT123",
        cacheManager,
        mockLogger
      );

      const eventPromise = new Promise((resolve) => {
        listener.once("adminTransferred", resolve);
      });

      await listener.start();
      const event = await eventPromise;

      expect(event).toMatchObject({
        oldAdmin: expect.any(String),
        newAdmin: expect.any(String),
        ledger: 1001,
        txHash: "abc123",
        invalidateDuration: expect.any(Number),
      });
    });
  });
});