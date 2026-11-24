import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";

const mockQueryApplicationLogs = jest.fn();
const mockCountApplicationLogs = jest.fn();
const mockPruneApplicationLogs = jest.fn();

await jest.unstable_mockModule("../src/database/application-logs.js", () => ({
  appendApplicationLog: jest.fn(),
  countApplicationLogs: mockCountApplicationLogs,
  evaluateLogAlerts: jest.fn(),
  pruneApplicationLogs: mockPruneApplicationLogs,
  queryApplicationLogs: mockQueryApplicationLogs,
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  requireAdminBearerOrRole: () => (_req, _res, next) => next(),
}));

const { applicationLogsRouter } = await import("../src/routes/application-logs.js");
const app = express();
app.use(express.json());
app.use("/api/v1/observability", applicationLogsRouter);

describe("application logs routes", () => {
  beforeEach(() => {
    mockQueryApplicationLogs.mockReset().mockReturnValue([{ id: 1 }]);
    mockCountApplicationLogs.mockReset().mockReturnValue(42);
    mockPruneApplicationLogs.mockReset().mockReturnValue({ deleted: 1, retentionDays: 30 });
  });

  test("parses, caps, and returns pagination metadata", async () => {
    const res = await request(app).get("/api/v1/observability/logs?limit=500&offset=10");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1, total: 42, limit: 200, offset: 10 });
    expect(mockQueryApplicationLogs).toHaveBeenCalledWith(expect.objectContaining({ limit: 200, offset: 10 }));
  });

  test("uses safe defaults for invalid pagination values", async () => {
    const res = await request(app).get("/api/v1/observability/logs?limit=invalid&offset=-5");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ limit: 50, offset: 0 });
  });

  test.each([0, -5, 366, 1.5])("rejects invalid retentionDays value %s", async (retentionDays) => {
    const res = await request(app)
      .post("/api/v1/observability/logs/retention/prune")
      .send({ retentionDays });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_parameter");
    expect(mockPruneApplicationLogs).not.toHaveBeenCalled();
  });

  test("prunes logs with a valid retention period", async () => {
    const res = await request(app)
      .post("/api/v1/observability/logs/retention/prune")
      .send({ retentionDays: 30 });

    expect(res.status).toBe(200);
    expect(mockPruneApplicationLogs).toHaveBeenCalledWith(30);
  });
});
