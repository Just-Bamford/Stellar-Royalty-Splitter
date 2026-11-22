import { afterAll, beforeEach, describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const databasePath = path.join(os.tmpdir(), `stellar-application-logs-${process.pid}.db`);
process.env.DATABASE_PATH = databasePath;

const { initializeDatabase } = await import("../src/database/core.js");
const {
  appendApplicationLog,
  evaluateLogAlerts,
  pruneApplicationLogs,
  queryApplicationLogs,
} = await import("../src/database/application-logs.js");
const { applicationLogsRouter } = await import("../src/routes/application-logs.js");
const { default: express } = await import("express");
const { default: request } = await import("supertest");
const { db } = await import("../src/database/core.js");
initializeDatabase();

process.env.ADMIN_ROTATE_TOKEN = "test-admin-token";

const app = express();
app.use(express.json());
app.use(applicationLogsRouter);

describe("centralized application logs (#874)", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM application_logs").run();
  });

  test("persists structured request data and searches by correlation ID", () => {
    appendApplicationLog({
      level: "error",
      message: "RPC request failed",
      correlationId: "corr-123",
      requestId: "req-456",
      metadata: { method: "GET", status: 502, provider: "horizon" },
    });

    const rows = queryApplicationLogs({ correlationId: "corr-123" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      level: "error",
      message: "RPC request failed",
      correlationId: "corr-123",
      requestId: "req-456",
      metadata: { status: 502 },
    });
  });

  test("triggers an alert after the configured error threshold", () => {
    for (let index = 0; index < 3; index += 1) {
      appendApplicationLog({ level: "error", message: `failure-${index}` });
    }

    expect(evaluateLogAlerts({ windowMinutes: 5, errorThreshold: 3 })).toMatchObject({
      triggered: true,
      errorCount: 3,
      threshold: 3,
      windowMinutes: 5,
    });
  });

  test("prunes records older than the configured retention window", () => {
    db.prepare(
      "INSERT INTO application_logs (timestamp, level, message, metadata) VALUES (datetime('now', '-10 days'), 'info', 'old', '{}')",
    ).run();
    appendApplicationLog({ level: "info", message: "recent" });

    expect(pruneApplicationLogs(7).deleted).toBe(1);
    expect(queryApplicationLogs().map((row) => row.message)).toEqual(["recent"]);
  });

  describe("GET /logs pagination parsing (#1414)", () => {
    beforeEach(() => {
      for (let i = 1; i <= 10; i += 1) {
        appendApplicationLog({ level: "info", message: `log-${i}` });
      }
    });

    test("falls back to default 50 when limit is invalid non-numeric string", async () => {
      const res = await request(app)
        .get("/logs?limit=abc")
        .set("Authorization", "Bearer test-admin-token");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(10);
    });

    test("falls back to 0 when offset is invalid non-numeric string", async () => {
      const res = await request(app)
        .get("/logs?offset=xyz")
        .set("Authorization", "Bearer test-admin-token");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(10);
    });

    test("parses string limit and offset and slices records accordingly", async () => {
      const res = await request(app)
        .get("/logs?limit=3&offset=2")
        .set("Authorization", "Bearer test-admin-token");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(3);
    });

    test("caps limit at 200 when requesting large limit", async () => {
      const res = await request(app)
        .get("/logs?limit=1000000")
        .set("Authorization", "Bearer test-admin-token");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(10);
    });

    test("clamps negative offset to 0", async () => {
      const res = await request(app)
        .get("/logs?offset=-10")
        .set("Authorization", "Bearer test-admin-token");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(10);
    });
  });
});

afterAll(() => {
  if (db.open) db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }
});
