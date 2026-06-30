import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

import logger from "../src/logger.js";
import { setCacheManagerForTests } from "../src/cache.js";

const COLLAB1 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLAB2 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const mockRedis = () => {
  const store = new Map();
  return {
    get: jest.fn(async (key) => store.get(key) || null),
    setex: jest.fn(async (key, ttl, value) => {
      store.set(key, value);
      return "OK";
    }),
    del: jest.fn(async (...keys) => {
      let deleted = 0;
      for (const key of keys) {
        if (store.delete(key)) deleted++;
      }
      return deleted;
    }),
    flushdb: jest.fn(async () => {
      store.clear();
      return "OK";
    }),
    ping: jest.fn(async () => "PONG"),
    quit: jest.fn(async () => "OK"),
  };
};

const mockSorobanRpc = () => {
  return {
    getEvents: jest.fn(async (options) => {
      return { events: [] };
    }),
  };
};

const mockCache = () => {
  const store = new Map();
  return {
    get: jest.fn(async (key) => {
      const value = store.get(key);
      return value ? JSON.parse(value) : null;
    }),
    set: jest.fn(async (key, value, ttl) => {
      store.set(key, JSON.stringify(value));
      return "OK";
    }),
    invalidate: jest.fn(async (key) => {
      const deleted = store.delete(key) ? 1 : 0;
      if (deleted) {
        logger.info("[Cache] Invalidated key", { key });
      }
      return deleted > 0;
    }),
    invalidateKeys: jest.fn(async (keys) => {
      let deleted = 0;
      for (const key of keys) {
        if (store.delete(key)) deleted++;
      }
      if (deleted) {
        logger.info("[Cache] Bulk invalidated keys", { keys, count: deleted });
      }
      return deleted;
    }),
    invalidateAdmin: jest.fn(async () => {
      const result = await this.invalidate("contract:admin");
      await this.invalidate("health:full");
      logger.info("[Cache] Admin cache invalidated", { adminInvalidated: result });
      return result;
    }),
    getEventWebhooks: jest.fn(async (contractId, eventType) => {
      const key = `event:webhooks:${contractId}:${eventType}`;
      const value = store.get(key);
      return value ? JSON.parse(value) : [];
    }),
    registerEventWebhook: jest.fn(async (contractId, eventType, webhook) => {
      const key = `event:webhooks:${contractId}:${eventType}`;
      const existing = (store.get(key) ? JSON.parse(store.get(key)) : []) || [];
      const webhookWithId = {
        ...webhook,
        id: webhook.id || `${contractId}:${eventType}:${Date.now()}`,
        registeredAt: webhook.registeredAt || new Date().toISOString(),
      };
      const updated = [...existing, webhookWithId];
      store.set(key, JSON.stringify(updated));
      return webhookWithId;
    }),
    unregisterEventWebhook: jest.fn(async (contractId, eventType, webhookId) => {
      const key = `event:webhooks:${contractId}:${eventType}`;
      const existing = (store.get(key) ? JSON.parse(store.get(key)) : []) || [];
      const updated = existing.filter((w) => w.id !== webhookId);
      if (updated.length === 0) {
        store.delete(key);
      } else {
        store.set(key, JSON.stringify(updated));
      }
      return updated.length < existing.length;
    }),
    ping: jest.fn(async () => true),
    disconnect: jest.fn(async () => {}),
  };
};

await jest.unstable_mockModule("../src/cache.js", () => ({
  getCacheManager: () => mockCache(),
  setCacheManagerForTests: (mock) => {
    const cacheMock = mockCache();
    Object.assign(cacheMock, mock);
    return cacheMock;
  },
}));

import { EventIndexer } from "../src/events/EventIndexer.js";

describe("EventIndexer", () => {
  let redisMock;
  let cacheMock;
  let sorobanRpcMock;
  let indexer;

  beforeEach(() => {
    redisMock = mockRedis();
    cacheMock = mockCache();
    sorobanRpcMock = mockSorobanRpc();
    setCacheManagerForTests(cacheMock);
    indexer = new EventIndexer(sorobanRpcMock, "CALIAS1234567890123456789012345678901234567890");

    jest.clearAllMocks();
    indexer.lastLedger = null;
    indexer.processedEvents.clear();
    cacheMock.getEventWebhooks.mockReturnValue([]);
  });

  afterEach(() => {
    if (indexer) {
      indexer.stop();
    }
    setCacheManagerForTests(null);
  });

  const setup = () => ({
    indexer,
    sorobanRpcMock,
    cacheMock,
    redisMock,
  });
  
  describe("constructor and basic functionality", () => {
    test("initializes with correct properties", () => {
      const { indexer, sorobanRpcMock, cacheMock } = setup();
      
      expect(indexer.sorobanRpc).toBe(sorobanRpcMock);
      expect(indexer.contractId).toBe("CALIAS1234567890123456789012345678901234567890");
      expect(indexer.cache).toBe(cacheMock);
      expect(indexer.isRunning).toBe(false);
      expect(indexer.pollIntervalMs).toBe(5000);
      expect(indexer.processedEvents.size).toBe(0);
    });

    test("uses custom poll interval from environment", () => {
      const originalEnv = process.env.EVENT_INDEXER_POLL_MS;
      process.env.EVENT_INDEXER_POLL_MS = "10000";
      
      try {
        const customIndexer = new EventIndexer(sorobanRpcMock, "CALIAS1234567890123456789012345678901234567890");
        expect(customIndexer.pollIntervalMs).toBe(10000);
      } finally {
        process.env.EVENT_INDEXER_POLL_MS = originalEnv;
      }
    });
  });

  describe("event indexing", () => {
    test("indexes distribute event", async () => {
      const { indexer, sorobanRpcMock, cacheMock } = setup();
      
      const mockEvent = {
        ledgerSequence: 12345,
        transactionHash: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
        eventIndex: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        topic: ["contract", "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.example"],
        value: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiIsImtpZCI6IkV4YW1wbGUifQ.example",
      };

      sorobanRpcMock.getEvents.mockResolvedValue({ events: [mockEvent] });

      await indexer._checkForEvents();

      expect(indexer.processedEvents.has(`${mockEvent.ledgerSequence}-${mockEvent.transactionHash}-${mockEvent.eventIndex}`)).toBe(true);
    });

    test("does not process duplicate events", async () => {
      const { indexer, sorobanRpcMock } = setup();
      
      const mockEvent = {
        ledgerSequence: 12345,
        transactionHash: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
        eventIndex: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        topic: ["contract", "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.example"],
        value: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiIsImtpZCI6IkV4YW1wbGUifQ.example",
      };

      sorobanRpcMock.getEvents.mockResolvedValue({ events: [mockEvent] });

      await indexer._checkForEvents();
      await indexer._checkForEvents();

      expect(indexer.processedEvents.size).toBe(1);
    });

    test("parses event body correctly", () => {
      const { indexer } = setup();
      
      const mockEvent = {
        topic: ["contract", Buffer.from("dist").toString("base64")],
        value: Buffer.from(JSON.stringify({ amount: "1000000", recipients: [{ address: "addr1", amount: "500000" }] })).toString("base64"),
      };

      const parsed = indexer._parseEventBody(mockEvent);
      expect(parsed.topic).toBe("dist");
      expect(parsed.data).toEqual({ amount: "1000000", recipients: [{ address: "addr1", amount: "500000" }] });
    });

    test("handles event parsing errors gracefully", () => {
      const { indexer } = setup();
      
      const mockEvent = {
        topic: ["contract", "invalid_base64"],
        value: "invalid_base64",
      };

      const parsed = indexer._parseEventBody(mockEvent);
      expect(parsed.topic).toBe("unknown");
      expect(parsed.data).toEqual({});
    });

    test("transforms distribute event data correctly", () => {
      const { indexer } = setup();
      
      const eventBody = { topic: "dist", data: { recipients: ["addr1", "addr2"], amount: "1000000" } };
      const mockEvent = {
        ledgerSequence: 12345,
        transactionHash: "tx123",
        timestamp: "2026-01-01T00:00:00.000Z",
      };

      const transformed = indexer._transformEventData(mockEvent, eventBody);
      expect(transformed.topic).toBe("dist");
      expect(transformed.ledgerSequence).toBe(12345);
      expect(transformed.amount).toBe("1000000");
      expect(transformed.recipients).toEqual(["addr1", "addr2"]);
      expect(transformed.type).toBe("distribution");
    });
  });

  describe("event webhook delivery", () => {
    test("delivers webhooks for matching event types", async () => {
      const { indexer, cacheMock } = setup();
      
      const mockEvent = {
        ledgerSequence: 12345,
        transactionHash: "tx123",
        eventIndex: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
      };

      const eventData = {
        eventId: "12345-tx123-1",
        ledgerSequence: 12345,
        transactionHash: "tx123",
        eventIndex: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        contractId: "CALIAS1234567890123456789012345678901234567890",
        eventType: "dist",
        eventData: { amount: "1000000" },
      };

      const mockWebhook = {
        id: "webhook123",
        url: "https://example.com/webhook",
        registeredAt: "2026-01-01T00:00:00.000Z",
      };

      cacheMock.getEventWebhooks.mockReturnValue([mockWebhook]);

      const fetchMock = jest.fn(() => Promise.resolve({ ok: true, status: 200 }));
      global.fetch = fetchMock;

      await indexer._triggerEventWebhooks(eventData);

      expect(cacheMock.getEventWebhooks).toHaveBeenCalledWith(indexer.contractId, "dist");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.com/webhook",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "X-Webhook-Event": "dist",
            "X-Webhook-Delivery": "12345-tx123-1",
          }),
        })
      );

      expect(fetchMock.mock.calls[0][1].body).toContain("dist");
    });

    test("continues processing even if webhook delivery fails", async () => {
      const { indexer, cacheMock } = setup();
      
      const eventData = {
        eventId: "12345-tx123-1",
        ledgerSequence: 12345,
        transactionHash: "tx123",
        eventIndex: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        contractId: "CALIAS1234567890123456789012345678901234567890",
        eventType: "dist",
        eventData: { amount: "1000000" },
      };

      const mockWebhook = {
        id: "webhook123",
        url: "https://example.com/webhook",
        registeredAt: "2026-01-01T00:00:00.000Z",
      };

      cacheMock.getEventWebhooks.mockReturnValue([mockWebhook]);

      const fetchMock = jest.fn(() => Promise.resolve({ ok: false, status: 500 }));
      global.fetch = fetchMock;

      await indexer._triggerEventWebhooks(eventData);

      expect(fetchMock).toHaveBeenCalled();
    });

    test("does not deliver webhooks when none are registered", async () => {
      const { indexer, cacheMock } = setup();
      
      cacheMock.getEventWebhooks.mockReturnValue([]);

      await indexer._triggerEventWebhooks({
        eventId: "test-id",
        contractId: indexer.contractId,
        eventType: "dist",
      });

      expect(cacheMock.getEventWebhooks).toHaveBeenCalledWith(indexer.contractId, "dist");
    });

    test("handles webhook timeout", async () => {
      const { indexer, cacheMock } = setup();
      
      const eventData = {
        eventId: "12345-tx123-1",
        contractId: indexer.contractId,
        eventType: "dist",
      };

      const mockWebhook = {
        id: "webhook123",
        url: "https://example.com/webhook",
        registeredAt: "2026-01-01T00:00:00.000Z",
      };

      cacheMock.getEventWebhooks.mockReturnValue([mockWebhook]);

      const originalTimeout = process.env.EVENT_WEBHOOK_TIMEOUT_MS;
      process.env.EVENT_WEBHOOK_TIMEOUT_MS = "50";

      try {
        const fetchMock = jest.fn(() => {
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve({ ok: true, status: 200 });
            }, 100);
          });
        });
        global.fetch = fetchMock;

        await indexer._triggerEventWebhooks(eventData);

        expect(fetchMock).toHaveBeenCalled();
      } finally {
        process.env.EVENT_WEBHOOK_TIMEOUT_MS = originalTimeout;
      }
    });
  });

  describe("start and stop lifecycle", () => {
    test("starts polling loop", async () => {
      const { indexer, sorobanRpcMock } = setup();
      
      await indexer.start();
      expect(indexer.isRunning).toBe(true);

      sorobanRpcMock.getEvents.mockResolvedValue({ events: [] });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(sorobanRpcMock.getEvents).toHaveBeenCalled();
    });

    test("stops polling loop", async () => {
      const { indexer, sorobanRpcMock } = setup();
      
      sorobanRpcMock.getEvents.mockResolvedValue({ events: [] });

      await indexer.start();
      expect(indexer.isRunning).toBe(true);
      expect(sorobanRpcMock.getEvents).toHaveBeenCalledTimes(1);

      sorobanRpcMock.getEvents.mockClear();

      await indexer.stop();
      expect(indexer.isRunning).toBe(false);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(sorobanRpcMock.getEvents).not.toHaveBeenCalled();
    });

    test("does not start when already running", async () => {
      const { indexer } = setup();
      
      const mockPollLoop = jest.spyOn(indexer, "_pollLoop");

      await indexer.start();
      expect(indexer.isRunning).toBe(true);
      expect(mockPollLoop).toHaveBeenCalledTimes(1);

      await indexer.start();
      expect(mockPollLoop).toHaveBeenCalledTimes(1);
    });
  });
});

export { EventIndexer };