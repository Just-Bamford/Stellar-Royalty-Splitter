import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";

describe("Audit log DB layer (backend/src/database/audit.js)", () => {
  let dbRows;
  let addAuditLog;
  let getAuditLog;

  beforeEach(async () => {
    jest.resetModules();
    dbRows = [];

    await jest.unstable_mockModule("../src/database/core.js", () => ({
      db: {
        prepare: (sql) => {
          if (sql.includes("INSERT INTO audit_log")) {
            return {
              run: (contractId, action, user, details) => {
                dbRows.push({
                  id: dbRows.length + 1,
                  contractId,
                  action,
                  user,
                  details,
                  timestamp: new Date().toISOString(),
                });
              },
            };
          }
          if (sql.includes("SELECT")) {
            return {
              all: (contractId, limit, offset) =>
                dbRows
                  .filter((r) => r.contractId === contractId)
                  .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
                  .slice(offset, offset + limit),
            };
          }
          throw new Error(`Unexpected SQL in mock: ${sql}`);
        },
      },
      countWrite: jest.fn(),
    }));

    ({ addAuditLog, getAuditLog } = await import("../src/database/audit.js"));
  });

  test("records a valid known action with actor, action, timestamp, and details", () => {
    addAuditLog(CONTRACT, "contract_initialized", WALLET, { transactionId: "tx-1" });

    const [entry] = getAuditLog(CONTRACT);
    expect(entry).toMatchObject({
      contractId: CONTRACT,
      action: "contract_initialized",
      user: WALLET,
      details: { transactionId: "tx-1" },
    });
    expect(entry.timestamp).toBeTruthy();
  });

  test("rejects an action outside the known allowlist", () => {
    expect(() => addAuditLog(CONTRACT, "totally_made_up_action", WALLET, {})).toThrow(
      /unsupported audit action/i
    );
    expect(dbRows).toHaveLength(0);
  });

  test("strips fields that look like secrets/tokens from details before persisting", () => {
    addAuditLog(CONTRACT, "royalty_rate_set", WALLET, {
      royaltyRate: 500,
      secretKey: "S" + "A".repeat(55),
      authToken: "abc123",
      password: "hunter2",
      privateKey: "leak",
    });

    const [entry] = getAuditLog(CONTRACT);
    expect(entry.details).toEqual({ royaltyRate: 500 });
    expect(entry.details).not.toHaveProperty("secretKey");
    expect(entry.details).not.toHaveProperty("authToken");
    expect(entry.details).not.toHaveProperty("password");
    expect(entry.details).not.toHaveProperty("privateKey");
  });

  test("retrieval returns entries ordered most-recent-first, paginated", () => {
    addAuditLog(CONTRACT, "contract_initialized", WALLET, { transactionId: "tx-1" });
    addAuditLog(CONTRACT, "distribution_initiated", WALLET, { transactionId: "tx-2" });
    addAuditLog(CONTRACT, "royalty_rate_set", WALLET, { royaltyRate: 250 });

    const page1 = getAuditLog(CONTRACT, 2, 0);
    expect(page1).toHaveLength(2);
    expect(page1[0].action).toBe("royalty_rate_set");

    const page2 = getAuditLog(CONTRACT, 2, 2);
    expect(page2).toHaveLength(1);
    expect(page2[0].action).toBe("contract_initialized");
  });
});

describe("Public audit API surface (backend/src/routes/history.js)", () => {
  let app;
  let addAuditLog;
  let getAuditLog;

  beforeEach(async () => {
    jest.resetModules();
    addAuditLog = jest.fn();
    getAuditLog = jest.fn();

    await jest.unstable_mockModule("../src/database/index.js", () => ({
      getTransactionHistory: jest.fn(),
      getTransactionCount: jest.fn(),
      getTransactionDetails: jest.fn(),
      getTransactionById: jest.fn(),
      getAuditLog,
      countAuditLog: jest.fn(),
      addAuditLog,
      updateTransactionStatus: jest.fn(),
      updateTransactionHash: jest.fn(),
      archiveContractEvents: jest.fn(),
      getArchivePolicy: jest.fn(),
      getArchivedEventCount: jest.fn(),
      getArchivedEvents: jest.fn(),
      updateArchivePolicy: jest.fn(),
    }));

    await jest.unstable_mockModule("../src/stellar.js", () => ({
      server: {},
      pollHorizonTransaction: jest.fn(),
    }));

    await jest.unstable_mockModule("../src/webhook-delivery.js", () => ({
      deliverDistributeWebhooks: jest.fn(),
    }));

    await jest.unstable_mockModule("../src/cache.js", () => ({
      cacheSet: jest.fn(),
      cacheGet: jest.fn(),
      cacheKey: jest.fn(),
      TTL: { history: 60000 },
    }));

    const { default: historyRouter } = await import("../src/routes/history.js");
    app = express();
    app.use(express.json());
    app.use("/api/v1", historyRouter);
    app.use((err, _req, res, _next) => {
      res.status(500).json({ error: err.message ?? "Internal server error" });
    });
  });

  test("there is no public POST /audit/:contractId route — audit entries cannot be written by clients", async () => {
    const res = await request(app)
      .post(`/api/v1/audit/${CONTRACT}`)
      .send({ action: "contract_initialized", user: WALLET, details: {} });

    // Express reports unmatched routes as 404; the important assertion is
    // that this never reaches addAuditLog with attacker-controlled input.
    expect(res.status).toBe(404);
    expect(addAuditLog).not.toHaveBeenCalled();
  });

  test("GET /audit/:contractId returns actor, action, timestamp, and public reference data only", async () => {
    getAuditLog.mockReturnValue([
      {
        id: 1,
        contractId: CONTRACT,
        action: "contract_initialized",
        user: WALLET,
        details: { transactionId: "tx-1", collaboratorCount: 2 },
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const res = await request(app).get(`/api/v1/audit/${CONTRACT}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data[0]).toMatchObject({
      action: "contract_initialized",
      user: WALLET,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(res.body.data[0].details).not.toHaveProperty("secretKey");
    expect(res.body.data[0].details).not.toHaveProperty("privateKey");
  });

  test("GET /audit/:contractId rejects an invalid contract ID", async () => {
    const res = await request(app).get("/api/v1/audit/not-a-contract-id");

    expect(res.status).toBe(400);
    expect(getAuditLog).not.toHaveBeenCalled();
  });

  test("GET /audit/:contractId respects pagination query params", async () => {
    getAuditLog.mockReturnValue([]);

    const res = await request(app).get(`/api/v1/audit/${CONTRACT}?limit=10&offset=5`);

    expect(res.status).toBe(200);
    expect(getAuditLog).toHaveBeenCalledWith(CONTRACT, 10, 5, {});
  });
});
