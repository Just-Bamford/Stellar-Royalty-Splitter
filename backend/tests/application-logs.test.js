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
const { db } = await import("../src/database/core.js");
initializeDatabase();

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
});

afterAll(() => {
  if (db.open) db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }
});
