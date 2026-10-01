/**
 * Tests for event sourcing and CQRS (#1066).
 *
 * Three suites:
 *  1. database/event-store unit tests — appendEvent, getAggregateEvents, replayEvents, optimistic concurrency
 *  2. projections unit tests — contractStateReducer, earningsReducer
 *  3. HTTP route integration tests — GET events, state, earnings, time-travel; POST commands
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN    = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const MOCK_EVENT = {
  eventId: "evt-001",
  eventType: "DistributionInitiated",
  aggregateType: "contract",
  aggregateId: CONTRACT,
  contractId: CONTRACT,
  actor: WALLET,
  payload: { transactionId: 1, tokenId: TOKEN },
  metadata: {},
  version: 1,
  occurredAt: "2026-09-28T12:00:00.000Z",
};

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — database/event-store unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("database/event-store — appendEvent", () => {
  const prepareMock = jest.fn();
  const runMock = jest.fn();
  const getMock = jest.fn();
  const allMock = jest.fn(() => []);
  const countWriteMock = jest.fn();

  prepareMock.mockImplementation(() => ({ run: runMock, get: getMock, all: allMock }));
  runMock.mockReturnValue({ lastInsertRowid: 1 });
  getMock.mockReturnValue({ nextVersion: 1, v: 0 });

  await jest.unstable_mockModule("../src/database/core.js", () => ({
    db: { prepare: prepareMock },
    countWrite: countWriteMock,
  }));

  const { appendEvent, getAggregateVersion, EventTypes, AggregateTypes } =
    await import("../src/database/event-store.js");

  beforeEach(() => jest.clearAllMocks());

  test("appendEvent returns eventId and version", () => {
    const result = appendEvent({
      eventType: EventTypes.DISTRIBUTION_INITIATED,
      aggregateType: AggregateTypes.CONTRACT,
      aggregateId: CONTRACT,
      contractId: CONTRACT,
      actor: WALLET,
      payload: { tokenId: TOKEN },
    });
    expect(result.eventId).toBeTruthy();
    expect(typeof result.version).toBe("number");
    expect(runMock).toHaveBeenCalled();
    expect(countWriteMock).toHaveBeenCalled();
  });

  test("appendEvent throws on missing required fields", () => {
    expect(() => appendEvent({ eventType: "Foo" })).toThrow(/required/);
  });

  test("optimistic concurrency conflict throws 409", () => {
    // Simulate current version = 5, but expectedVersion = 3
    getMock.mockReturnValueOnce({ v: 5 });
    expect(() =>
      appendEvent({
        eventType: EventTypes.DISTRIBUTION_INITIATED,
        aggregateType: AggregateTypes.CONTRACT,
        aggregateId: CONTRACT,
        expectedVersion: 3,
      })
    ).toThrow(/concurrency conflict/);
  });

  test("EventTypes exports correct string values", () => {
    expect(EventTypes.DISTRIBUTION_INITIATED).toBe("DistributionInitiated");
    expect(EventTypes.CONTRACT_INITIALIZED).toBe("ContractInitialized");
    expect(EventTypes.DISPUTE_OPENED).toBe("DisputeOpened");
  });

  test("AggregateTypes exports correct string values", () => {
    expect(AggregateTypes.CONTRACT).toBe("contract");
    expect(AggregateTypes.COLLABORATOR).toBe("collaborator");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — projection unit tests (pure reducers, no mocks needed)
// ─────────────────────────────────────────────────────────────────────────────

describe("contractStateReducer — projection", () => {
  const { contractStateReducer } = await import(
    "../src/projections/contract-state-projection.js"
  );

  const initial = { contractId: CONTRACT, distributions: [], collaborators: [], initialized: false };

  test("CONTRACT_INITIALIZED sets initialized=true and stores collaborators", () => {
    const state = contractStateReducer(initial, {
      eventType: "ContractInitialized",
      actor: WALLET,
      occurredAt: "2026-01-01T00:00:00Z",
      payload: { collaborators: [WALLET], shares: [10000] },
    });
    expect(state.initialized).toBe(true);
    expect(state.collaborators).toEqual([WALLET]);
    expect(state.initializedBy).toBe(WALLET);
  });

  test("DISTRIBUTION_INITIATED appends to distributions array", () => {
    const s1 = contractStateReducer(initial, {
      eventType: "DistributionInitiated",
      actor: WALLET,
      occurredAt: "2026-06-01T00:00:00Z",
      payload: { transactionId: 1, tokenId: TOKEN },
    });
    expect(s1.distributions).toHaveLength(1);
    expect(s1.distributions[0].transactionId).toBe(1);
    expect(s1.lastDistributionAt).toBe("2026-06-01T00:00:00Z");
  });

  test("DISTRIBUTION_CONFIRMED marks matching distribution with txHash", () => {
    const s1 = contractStateReducer(initial, {
      eventType: "DistributionInitiated",
      actor: WALLET,
      occurredAt: "2026-06-01T00:00:00Z",
      payload: { transactionId: 1, tokenId: TOKEN },
    });
    const s2 = contractStateReducer(s1, {
      eventType: "DistributionConfirmed",
      actor: "system",
      occurredAt: "2026-06-01T01:00:00Z",
      payload: { transactionId: 1, txHash: "abc123" },
    });
    expect(s2.distributions[0].txHash).toBe("abc123");
    expect(s2.distributions[0].confirmedAt).toBe("2026-06-01T01:00:00Z");
  });

  test("unknown event type leaves state unchanged", () => {
    const state = contractStateReducer(initial, {
      eventType: "UnknownEvent",
      payload: {},
    });
    expect(state).toBe(initial);
  });

  test("reducer is pure — does not mutate input state", () => {
    const frozen = Object.freeze({ ...initial, distributions: Object.freeze([]) });
    expect(() =>
      contractStateReducer(frozen, {
        eventType: "DistributionInitiated",
        actor: WALLET,
        occurredAt: "2026-06-01T00:00:00Z",
        payload: { transactionId: 2, tokenId: TOKEN },
      })
    ).not.toThrow();
  });
});

describe("earningsReducer — projection", () => {
  const { earningsReducer } = await import(
    "../src/projections/earnings-projection.js"
  );

  const initial = { contractId: CONTRACT, distributionCount: 0, lastDistributionAt: null, tokenIds: [] };

  test("increments distributionCount on DistributionInitiated", () => {
    const s = earningsReducer(initial, {
      eventType: "DistributionInitiated",
      occurredAt: "2026-06-01T00:00:00Z",
      payload: { tokenId: TOKEN },
    });
    expect(s.distributionCount).toBe(1);
    expect(s.lastDistributionAt).toBe("2026-06-01T00:00:00Z");
    expect(s.tokenIds).toContain(TOKEN);
  });

  test("deduplicates tokenIds", () => {
    const s1 = earningsReducer(initial, { eventType: "DistributionInitiated", occurredAt: "t1", payload: { tokenId: TOKEN } });
    const s2 = earningsReducer(s1,     { eventType: "DistributionInitiated", occurredAt: "t2", payload: { tokenId: TOKEN } });
    expect(s2.tokenIds).toHaveLength(1);
    expect(s2.distributionCount).toBe(2);
  });

  test("ignores non-distribution events", () => {
    const s = earningsReducer(initial, { eventType: "DisputeOpened", payload: {} });
    expect(s).toBe(initial);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — HTTP route integration tests
// ─────────────────────────────────────────────────────────────────────────────

describe("events/commands routes — integration", () => {
  const queryContractHistoryMock = jest.fn(() => ({ events: [], total: 0, limit: 50, offset: 0 }));
  const projectContractStateMock = jest.fn(async () => ({
    state: { contractId: CONTRACT, initialized: false, distributions: [], collaborators: [] },
    eventCount: 0,
    lastEventId: null,
    asOf: null,
  }));
  const queryStateAtTimeMock = jest.fn(async (contractId, asOf) => ({
    state: { contractId, initialized: false },
    eventCount: 0,
    asOf,
  }));
  const projectEarningsSummaryMock = jest.fn(() => ({
    contractId: CONTRACT, distributionCount: 3, lastDistributionAt: "2026-09-28T00:00:00Z", tokenIds: [TOKEN],
  }));
  const getEventByIdMock = jest.fn(() => MOCK_EVENT);
  const handleDistributeCommandMock = jest.fn();
  const handleInitializeCommandMock = jest.fn();

  await jest.unstable_mockModule("../src/queries/contract-history-query.js", () => ({
    queryContractHistory: queryContractHistoryMock,
  }));
  await jest.unstable_mockModule("../src/projections/contract-state-projection.js", () => ({
    projectContractState: projectContractStateMock,
    contractStateReducer: jest.fn((s) => s),
  }));
  await jest.unstable_mockModule("../src/queries/time-travel-query.js", () => ({
    queryStateAtTime: queryStateAtTimeMock,
  }));
  await jest.unstable_mockModule("../src/projections/earnings-projection.js", () => ({
    projectEarningsSummary: projectEarningsSummaryMock,
    earningsReducer: jest.fn((s) => s),
  }));
  await jest.unstable_mockModule("../src/events/event-store.js", () => ({
    getEventById: getEventByIdMock,
    getContractEvents: jest.fn(() => []),
    countContractEvents: jest.fn(() => 0),
    getAggregateEvents: jest.fn(() => []),
    getAggregateVersion: jest.fn(() => 0),
    replayEvents: jest.fn(async () => ({ state: {}, eventCount: 0, lastEventId: null, asOf: null })),
    appendEvent: jest.fn(async () => ({ eventId: "evt-001", version: 1 })),
    EventTypes: {
      CONTRACT_INITIALIZED: "ContractInitialized",
      DISTRIBUTION_INITIATED: "DistributionInitiated",
    },
    AggregateTypes: { CONTRACT: "contract", DISPUTE: "dispute", COLLABORATOR: "collaborator" },
    subscribe: jest.fn(() => () => {}),
  }));
  await jest.unstable_mockModule("../src/commands/distribute-command.js", () => ({
    handleDistributeCommand: handleDistributeCommandMock,
  }));
  await jest.unstable_mockModule("../src/commands/initialize-command.js", () => ({
    handleInitializeCommand: handleInitializeCommandMock,
  }));
  await jest.unstable_mockModule("../src/database/index.js", () => ({
    initializeDatabase: jest.fn(),
    getMigrationVersion: jest.fn(() => 26),
    addAuditLog: jest.fn(),
    recordTransaction: jest.fn(() => 1),
  }));

  const { default: app } = await import("./app.js");

  beforeEach(() => jest.clearAllMocks());

  // ── GET /api/v1/events/:contractId ────────────────────────────────────────

  test("GET events — 200 returns paginated event list", async () => {
    queryContractHistoryMock.mockReturnValueOnce({ events: [MOCK_EVENT], total: 1, limit: 50, offset: 0 });
    const res = await request(app).get(`/api/v1/events/${CONTRACT}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  test("GET events — 400 for invalid contractId", async () => {
    const res = await request(app).get("/api/v1/events/INVALID");
    expect(res.status).toBe(400);
  });

  test("GET events — passes eventType filter", async () => {
    await request(app).get(`/api/v1/events/${CONTRACT}?eventType=DistributionInitiated`);
    expect(queryContractHistoryMock).toHaveBeenCalledWith(
      CONTRACT,
      expect.objectContaining({ eventType: "DistributionInitiated" })
    );
  });

  // ── GET /api/v1/events/:contractId/state ─────────────────────────────────

  test("GET state — 200 returns projected state", async () => {
    const res = await request(app).get(`/api/v1/events/${CONTRACT}/state`);
    expect(res.status).toBe(200);
    expect(res.body.state.contractId).toBe(CONTRACT);
    expect(projectContractStateMock).toHaveBeenCalled();
  });

  test("GET state — time-travel uses queryStateAtTime when asOf provided", async () => {
    const asOf = "2026-06-01T00:00:00Z";
    const res = await request(app).get(`/api/v1/events/${CONTRACT}/state?asOf=${encodeURIComponent(asOf)}`);
    expect(res.status).toBe(200);
    expect(queryStateAtTimeMock).toHaveBeenCalledWith(CONTRACT, asOf);
    expect(res.body.asOf).toBe(asOf);
  });

  // ── GET /api/v1/events/:contractId/earnings ───────────────────────────────

  test("GET earnings — 200 returns earnings projection", async () => {
    const res = await request(app).get(`/api/v1/events/${CONTRACT}/earnings`);
    expect(res.status).toBe(200);
    expect(res.body.distributionCount).toBe(3);
    expect(projectEarningsSummaryMock).toHaveBeenCalledWith(CONTRACT, expect.anything());
  });

  // ── GET /api/v1/events/event/:eventId ────────────────────────────────────

  test("GET single event by ID — 200", async () => {
    const res = await request(app).get("/api/v1/events/event/evt-001");
    expect(res.status).toBe(200);
    expect(res.body.event.eventId).toBe("evt-001");
  });

  test("GET single event by ID — 404 when not found", async () => {
    getEventByIdMock.mockReturnValueOnce(null);
    const res = await request(app).get("/api/v1/events/event/nonexistent");
    expect(res.status).toBe(404);
  });

  // ── POST /api/v1/commands/distribute ─────────────────────────────────────

  test("POST commands/distribute — 200 on success", async () => {
    handleDistributeCommandMock.mockResolvedValueOnce({ xdr: "xdr-val", transactionId: 42 });
    const res = await request(app)
      .post("/api/v1/commands/distribute")
      .send({ contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.transactionId).toBe(42);
    expect(handleDistributeCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN })
    );
  });

  test("POST commands/distribute — 400 on validation failure", async () => {
    const res = await request(app)
      .post("/api/v1/commands/distribute")
      .send({ contractId: CONTRACT }); // missing walletAddress and tokenId
    expect(res.status).toBe(400);
    expect(handleDistributeCommandMock).not.toHaveBeenCalled();
  });

  // ── POST /api/v1/commands/initialize ─────────────────────────────────────

  test("POST commands/initialize — 200 on success", async () => {
    handleInitializeCommandMock.mockResolvedValueOnce({ xdr: "init-xdr", transactionId: 1 });
    const res = await request(app)
      .post("/api/v1/commands/initialize")
      .send({
        contractId: CONTRACT,
        walletAddress: WALLET,
        collaborators: [WALLET],
        shares: [10000],
      });
    expect(res.status).toBe(200);
    expect(res.body.transactionId).toBe(1);
  });

  test("POST commands/initialize — 400 when shares don't sum to 10000", async () => {
    const res = await request(app)
      .post("/api/v1/commands/initialize")
      .send({
        contractId: CONTRACT,
        walletAddress: WALLET,
        collaborators: [WALLET],
        shares: [5000], // must be 10000
      });
    expect(res.status).toBe(400);
    expect(handleInitializeCommandMock).not.toHaveBeenCalled();
  });
});
