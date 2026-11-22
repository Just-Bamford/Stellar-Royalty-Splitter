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

  describe("POST /logs/retention/prune validation (#1415)", () => {
    test("rejects retentionDays: 0 with 400", async () => {
      const res = await request(app)
        .post("/logs/retention/prune")
        .set("Authorization", "Bearer test-admin-token")
        .send({ retentionDays: 0 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/retentionDays must be between 1 and 365/);
    });

    test("rejects retentionDays: -5 with 400", async () => {
      const res = await request(app)
        .post("/logs/retention/prune")
        .set("Authorization", "Bearer test-admin-token")
        .send({ retentionDays: -5 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/retentionDays must be between 1 and 365/);
    });

    test("rejects retentionDays: 400 with 400", async () => {
      const res = await request(app)
        .post("/logs/retention/prune")
        .set("Authorization", "Bearer test-admin-token")
        .send({ retentionDays: 400 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/retentionDays must be between 1 and 365/);
    });

    test("rejects non-numeric retentionDays with 400", async () => {
      const res = await request(app)
        .post("/logs/retention/prune")
        .set("Authorization", "Bearer test-admin-token")
        .send({ retentionDays: "invalid" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/retentionDays must be between 1 and 365/);
    });

    test("prunes logs older than 30 days when retentionDays: 30", async () => {
      db.prepare(
        "INSERT INTO application_logs (timestamp, level, message, metadata) VALUES (datetime('now', '-35 days'), 'info', 'very-old', '{}')",
      ).run();
      appendApplicationLog({ level: "info", message: "recent-log" });

      const res = await request(app)
        .post("/logs/retention/prune")
        .set("Authorization", "Bearer test-admin-token")
        .send({ retentionDays: 30 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deleted).toBe(1);
      expect(queryApplicationLogs().map((row) => row.message)).toEqual(["recent-log"]);
    });
  });
});

afterAll(() => {
  if (db.open) db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }
});
