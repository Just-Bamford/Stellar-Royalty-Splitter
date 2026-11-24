import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ─── Fake db ──────────────────────────────────────────────────────────────────
// Holds the rows that the /audit endpoint will read back.
let fakeAuditRows = [];

const mockDb = {
  prepare: (sql) => {
    // Paginated event query
    if (sql.includes("LIMIT ? OFFSET ?")) {
      return {
        all: (limit, offset) => fakeAuditRows.slice(offset, offset + limit),
      };
    }
    // Count query
    if (sql.includes("COUNT(*)")) {
      return { get: () => ({ count: fakeAuditRows.length }) };
    }
    // Any other query (used by other routes in the same router)
    return { all: () => [], get: () => null, run: () => ({ lastInsertRowid: 0, changes: 0 }) };
  },
};

await jest.unstable_mockModule("../src/database/core.js", () => ({
  db: mockDb,
  countWrite: jest.fn(),
}));

// ─── Bypass auth ──────────────────────────────────────────────────────────────
await jest.unstable_mockModule("../src/middleware/rbac-check.js", () => ({
  attachRbacIdentity: (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
  requireAnyPermission: () => (_req, _res, next) => next(),
}));

// validation.js imports from shared/stellar-address.js which needs @stellar/stellar-sdk.
// Provide parsePagination directly so we don't pull in that dependency chain.
await jest.unstable_mockModule("../src/validation.js", () => {
  // Inline the same logic as the real parsePagination to avoid the import chain.
  function parsePagination(query, res, defaultLimit = 50, maxLimit = 100) {
    if (query.limit !== undefined && isNaN(parseInt(query.limit))) {
      res.status(400).json({ error: { code: "invalid_query_parameter", message: "limit must be a number" } });
      return null;
    }
    if (query.offset !== undefined && isNaN(parseInt(query.offset))) {
      res.status(400).json({ error: { code: "invalid_query_parameter", message: "offset must be a number" } });
      return null;
    }
    const limit = Math.min(Math.max(parseInt(query.limit) || defaultLimit, 1), maxLimit);
    const offset = Math.max(parseInt(query.offset) || 0, 0);
    return { limit, offset };
  }
  return {
    parsePagination,
    validate: () => (_req, _res, next) => next(),
    parseCursorPagination: jest.fn(),
  };
});

// models/rbac.js reads from db at module load; mock it so it doesn't blow up.
await jest.unstable_mockModule("../src/models/rbac.js", () => ({
  PERMISSIONS: {
    SETTINGS_READ: "settings:read", SETTINGS_UPDATE: "settings:update",
    COLLABORATORS_READ: "collaborators:read", COLLABORATORS_MANAGE: "collaborators:manage",
    FINANCIALS_READ: "financials:read", FINANCIALS_EXPORT: "financials:export",
    DISPUTES_READ: "disputes:read", DISPUTES_APPROVE: "disputes:approve",
    REPORTS_READ: "reports:read", REPORTS_EXPORT: "reports:export",
    PERMISSIONS_READ: "permissions:read", PERMISSIONS_MANAGE: "permissions:manage",
    AUDIT_READ: "audit:read",
  },
  ROLES: ["viewer", "editor", "accountant", "approver", "admin"],
  ROLE_PERMISSIONS: {},
  getActiveRoles: jest.fn(() => []),
  getEffectivePermissions: jest.fn(() => new Set()),
  getRbacUsers: jest.fn(() => []),
  isValidExpiration: jest.fn(() => true),
  auditPermissionChange: jest.fn(),
  hasPermission: jest.fn(() => true),
  isKnownPermission: jest.fn(() => true),
  expireTemporaryPermissions: jest.fn(),
  normalizeRole: jest.fn((r) => r),
}));

import express from "express";
const { permissionsRouter } = await import("../src/routes/permissions.js");

const app = express();
app.use(express.json());
app.use("/api/v1/permissions", permissionsRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeEvents(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    actorUserId: 1,
    affectedUserId: 2,
    action: "role_assigned",
    previousState: null,
    newState: null,
    createdAt: new Date().toISOString(),
  }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe("GET /api/v1/permissions/audit — pagination", () => {
  beforeEach(() => {
    fakeAuditRows = makeEvents(120);
  });

  test("defaults: returns first 50 events with total count", async () => {
    const res = await request(app).get("/api/v1/permissions/audit");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(50);
    expect(res.body.total).toBe(120);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
  });

  test("?limit=10&offset=0 returns first 10 events", async () => {
    const res = await request(app).get("/api/v1/permissions/audit?limit=10&offset=0");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(10);
    expect(res.body.total).toBe(120);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });

  test("?limit=50&offset=50 returns second page", async () => {
    const res = await request(app).get("/api/v1/permissions/audit?limit=50&offset=50");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(50);
    expect(res.body.offset).toBe(50);
    expect(res.body.total).toBe(120);
  });

  test("?limit=200&offset=0 returns all 120 events (max limit 200)", async () => {
    const res = await request(app).get("/api/v1/permissions/audit?limit=200&offset=0");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(120);
    expect(res.body.limit).toBe(200);
    expect(res.body.total).toBe(120);
  });

  test("?limit=200&offset=200 returns empty events when past end", async () => {
    const res = await request(app).get("/api/v1/permissions/audit?limit=200&offset=200");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(0);
    expect(res.body.total).toBe(120);
    expect(res.body.offset).toBe(200);
  });

  test("limit is capped at 200 — ?limit=500 is treated as 200", async () => {
    fakeAuditRows = makeEvents(250);
    const res = await request(app).get("/api/v1/permissions/audit?limit=500&offset=0");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
    expect(res.body.events).toHaveLength(200);
  });

  test("?limit=abc returns 400", async () => {
    const res = await request(app).get("/api/v1/permissions/audit?limit=abc");
    expect(res.status).toBe(400);
  });

  test("?offset=abc returns 400", async () => {
    const res = await request(app).get("/api/v1/permissions/audit?offset=abc");
    expect(res.status).toBe(400);
  });

  test("response includes events array and total even when empty store", async () => {
    fakeAuditRows = [];
    const res = await request(app).get("/api/v1/permissions/audit");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  test("total reflects actual row count, not just current page size", async () => {
    fakeAuditRows = makeEvents(75);
    const res = await request(app).get("/api/v1/permissions/audit?limit=10&offset=0");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(10);
    expect(res.body.total).toBe(75);
  });
});
