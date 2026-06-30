import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ADMIN = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLAB1 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLAB2 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const addAuditLog = jest.fn();
const recordContractConsistencyCheck = jest.fn();
const getContractStateSnapshot = jest.fn();
const getConfiguredContractId = jest.fn(() => CONTRACT);
const dbPrepare = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  addAuditLog,
  db: { prepare: dbPrepare },
}));

await jest.unstable_mockModule("../src/metrics.js", () => ({
  recordCacheHit: jest.fn(),
  recordCacheMiss: jest.fn(),
  recordContractConsistencyCheck,
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  getContractStateSnapshot,
  getConfiguredContractId,
  isContractInitialized: jest.fn(),
  server: { simulateTransaction: jest.fn() },
  networkPassphrase: "Test SDF Network ; September 2015",
  addressToScVal: jest.fn((value) => value),
  getContractVersionFromContract: jest.fn(),
  getNetworkLabel: jest.fn(() => "Testnet"),
}));

await jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  default: {
    Address: {
      fromScVal: jest.fn((value) => ({ toString: () => String(value) })),
    },
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn((method, ...args) => ({ method, args })),
    })),
    SorobanRpc: {
      Api: { isSimulationError: jest.fn(() => false) },
    },
    TransactionBuilder: jest.fn(),
    BASE_FEE: "100",
    Account: jest.fn(),
  },
}));

const {
  compareContractStates,
  getExpectedContractStateFromDb,
  verifyContractStateConsistency,
} = await import("../src/contract-state-consistency.js");
const { resetMetrics } = await import("../src/metrics.js").catch(() => ({ resetMetrics: null }));
const { contractRouter } = await import("../src/routes/contract.js");

function expectedState(overrides = {}) {
  return {
    contractId: CONTRACT,
    initialized: true,
    adminAddress: ADMIN,
    recipients: [
      { address: COLLAB1, basisPoints: 6000 },
      { address: COLLAB2, basisPoints: 4000 },
    ],
    totalShares: 10000,
    royaltyRate: 750,
    secondaryPool: "125",
    ...overrides,
  };
}

function actualState(overrides = {}) {
  return {
    contractId: CONTRACT,
    initialized: true,
    adminAddress: ADMIN,
    recipients: [
      { address: COLLAB2, basisPoints: 4000 },
      { address: COLLAB1, basisPoints: 6000 },
    ],
    totalShares: 10000,
    royaltyRate: 750,
    secondaryPool: "125",
    ...overrides,
  };
}

function mockExpectedDbQueries() {
  dbPrepare.mockImplementation((sql) => {
    if (sql.includes("action IN")) {
      return {
        all: jest.fn(() => [
          {
            user: ADMIN,
            details: JSON.stringify({
              collaborators: [ADMIN, COLLAB2],
              shares: [7000, 3000],
            }),
          },
        ]),
      };
    }

    if (sql.includes("action = 'royalty_rate_set'")) {
      return {
        get: jest.fn(() => ({
          details: JSON.stringify({ royaltyRate: 650 }),
        })),
      };
    }

    if (sql.includes("SUM(CAST(royaltyAmount AS INTEGER))")) {
      return {
        get: jest.fn(() => ({ pendingPool: 42 })),
      };
    }

    return { all: jest.fn(() => []), get: jest.fn(() => null) };
  });
}

describe("contract state consistency verification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMetrics?.();
  });

  test("treats equivalent DB and on-chain states as consistent", () => {
    const discrepancies = compareContractStates(expectedState(), actualState());

    expect(discrepancies).toEqual([]);
  });

  test("detects collaborator share mismatches", () => {
    const discrepancies = compareContractStates(
      expectedState(),
      actualState({
        recipients: [
          { address: COLLAB1, basisPoints: 5000 },
          { address: COLLAB2, basisPoints: 5000 },
        ],
      }),
    );

    expect(discrepancies).toEqual([
      expect.objectContaining({
        field: "recipients",
        severity: "critical",
      }),
    ]);
  });

  test("detects royalty-rate and pending-pool mismatches", () => {
    const discrepancies = compareContractStates(
      expectedState(),
      actualState({ royaltyRate: 500, secondaryPool: "0" }),
    );

    expect(discrepancies.map((d) => d.field)).toEqual(["royaltyRate", "secondaryPool"]);
  });

  test("reconstructs expected state from audit and secondary-sales tables", () => {
    mockExpectedDbQueries();

    const expected = getExpectedContractStateFromDb(CONTRACT);

    expect(expected).toMatchObject({
      contractId: CONTRACT,
      initialized: true,
      adminAddress: ADMIN,
      totalShares: 10000,
      royaltyRate: 650,
      secondaryPool: "42",
      recipients: [
        { address: ADMIN, basisPoints: 7000 },
        { address: COLLAB2, basisPoints: 3000 },
      ],
    });
  });

  test("logs, audits, and records metrics when discrepancies are found", async () => {
    const log = { error: jest.fn(), info: jest.fn() };

    const result = await verifyContractStateConsistency(CONTRACT, {
      expectedStateReader: jest.fn(() => expectedState()),
      onChainStateReader: jest.fn(() => actualState({ totalShares: 9000 })),
      log,
    });

    expect(result.consistent).toBe(false);
    expect(result.discrepancies).toEqual([
      expect.objectContaining({ field: "totalShares" }),
    ]);
    expect(log.error).toHaveBeenCalledWith(
      "Contract state consistency discrepancies detected",
      expect.objectContaining({ contractId: CONTRACT, discrepancyCount: 1 }),
    );
    expect(addAuditLog).toHaveBeenCalledWith(
      CONTRACT,
      "contract_state_discrepancy_detected",
      "system",
      expect.objectContaining({ discrepancyCount: 1 }),
    );
    expect(recordContractConsistencyCheck).toHaveBeenCalledWith({
      success: true,
      discrepancyCount: 1,
    });
  });

  test("manual verify endpoint returns 409 with discrepancy details", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/contract", contractRouter);
    app.use((err, _req, res, _next) => {
      res.status(500).json({ error: err.message });
    });

    getContractStateSnapshot.mockResolvedValue(
      actualState({ adminAddress: COLLAB1, secondaryPool: "0" }),
    );
    dbPrepare.mockImplementation((sql) => {
      if (sql.includes("action IN")) {
        return {
          all: jest.fn(() => [
            {
              details: JSON.stringify({
                collaborators: [COLLAB1, COLLAB2],
                shares: [6000, 4000],
              }),
            },
          ]),
        };
      }
      if (sql.includes("action = 'royalty_rate_set'")) {
        return { get: jest.fn(() => ({ details: JSON.stringify({ royaltyRate: 750 }) })) };
      }
      return { get: jest.fn(() => ({ pendingPool: 125 })), all: jest.fn(() => []) };
    });

    const res = await request(app).get(`/api/v1/contract/verify?contractId=${CONTRACT}`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      contractId: CONTRACT,
      consistent: false,
      discrepancyCount: 1,
      discrepancies: [expect.objectContaining({ field: "secondaryPool" })],
    });
  });
});
