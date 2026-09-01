/**
 * Tests for pagination and analytics query validation (#394 — MEDIUM-16).
 *
 * Covers:
 *  - paginationSchema: limit bounds (1–100, default 10), offset >= 0, coercion
 *  - analyticsQuerySchema: ISO date validation, start < end ordering, topLimit bounds
 *  - validateQuery() middleware: 400 on bad input, req.query replacement on success
 *  - parsePagination(): non-numeric rejection, clamping, negative offset rejection
 */
import { describe, test, expect, jest } from "@jest/globals";
import {
  paginationSchema,
  analyticsQuerySchema,
  validateQuery,
  parsePagination,
} from "../src/validation.js";
import { sendError } from "../src/error-response.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock Express res object that captures sendValidationError calls. */
function mockRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

/** Build a minimal mock Express req with query params. */
function mockReq(query = {}) {
  return { query: { ...query } };
}

// ---------------------------------------------------------------------------
// paginationSchema
// ---------------------------------------------------------------------------

describe("paginationSchema", () => {
  test("defaults: empty input gives limit=10, offset=0", () => {
    const result = paginationSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ limit: 10, offset: 0 });
  });

  test("coerces string values from query strings", () => {
    const result = paginationSchema.safeParse({ limit: "25", offset: "50" });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ limit: 25, offset: 50 });
  });

  test("accepts limit=1 (minimum boundary)", () => {
    const result = paginationSchema.safeParse({ limit: "1" });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(1);
  });

  test("accepts limit=100 (maximum boundary)", () => {
    const result = paginationSchema.safeParse({ limit: "100" });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(100);
  });

  test("rejects limit=0 (below minimum)", () => {
    const result = paginationSchema.safeParse({ limit: "0" });
    expect(result.success).toBe(false);
    const messages = result.error.issues.map((i) => i.message).join(" ");
    expect(messages).toMatch(/at least 1/i);
  });

  test("rejects limit=101 (above maximum)", () => {
    const result = paginationSchema.safeParse({ limit: "101" });
    expect(result.success).toBe(false);
    const messages = result.error.issues.map((i) => i.message).join(" ");
    expect(messages).toMatch(/at most 100/i);
  });

  test("rejects non-numeric limit", () => {
    const result = paginationSchema.safeParse({ limit: "abc" });
    expect(result.success).toBe(false);
  });

  test("rejects negative offset", () => {
    const result = paginationSchema.safeParse({ offset: "-1" });
    expect(result.success).toBe(false);
    const messages = result.error.issues.map((i) => i.message).join(" ");
    expect(messages).toMatch(/>= 0/i);
  });

  test("accepts offset=0 (boundary)", () => {
    const result = paginationSchema.safeParse({ offset: "0" });
    expect(result.success).toBe(true);
    expect(result.data.offset).toBe(0);
  });

  test("accepts large valid offset", () => {
    const result = paginationSchema.safeParse({ limit: "10", offset: "9999" });
    expect(result.success).toBe(true);
    expect(result.data.offset).toBe(9999);
  });
});

// ---------------------------------------------------------------------------
// analyticsQuerySchema
// ---------------------------------------------------------------------------

describe("analyticsQuerySchema", () => {
  test("defaults: empty input gives topLimit=10, no dates", () => {
    const result = analyticsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data.topLimit).toBe(10);
    expect(result.data.start).toBeUndefined();
    expect(result.data.end).toBeUndefined();
  });

  test("accepts valid ISO date strings", () => {
    const result = analyticsQuerySchema.safeParse({
      start: "2024-01-01T00:00:00Z",
      end: "2024-06-30T23:59:59Z",
    });
    expect(result.success).toBe(true);
  });

  test("accepts YYYY-MM-DD date strings", () => {
    const result = analyticsQuerySchema.safeParse({
      start: "2024-01-01",
      end: "2024-12-31",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid start date", () => {
    const result = analyticsQuerySchema.safeParse({ start: "not-a-date" });
    expect(result.success).toBe(false);
    const messages = result.error.issues.map((i) => i.message).join(" ");
    expect(messages).toMatch(/invalid start date/i);
  });

  test("rejects invalid end date", () => {
    const result = analyticsQuerySchema.safeParse({ end: "2024-13-45" });
    expect(result.success).toBe(false);
    const messages = result.error.issues.map((i) => i.message).join(" ");
    expect(messages).toMatch(/invalid end date/i);
  });

  test("rejects start date after end date", () => {
    const result = analyticsQuerySchema.safeParse({
      start: "2024-12-31",
      end: "2024-01-01",
    });
    expect(result.success).toBe(false);
    const messages = result.error.issues.map((i) => i.message).join(" ");
    expect(messages).toMatch(/start date must be before end date/i);
  });

  test("accepts equal start and end date (same-day range)", () => {
    const result = analyticsQuerySchema.safeParse({
      start: "2024-06-15",
      end: "2024-06-15",
    });
    expect(result.success).toBe(true);
  });

  test("rejects topLimit=0", () => {
    const result = analyticsQuerySchema.safeParse({ topLimit: "0" });
    expect(result.success).toBe(false);
    const messages = result.error.issues.map((i) => i.message).join(" ");
    expect(messages).toMatch(/at least 1/i);
  });

  test("rejects topLimit=101", () => {
    const result = analyticsQuerySchema.safeParse({ topLimit: "101" });
    expect(result.success).toBe(false);
    const messages = result.error.issues.map((i) => i.message).join(" ");
    expect(messages).toMatch(/at most 100/i);
  });

  test("accepts topLimit=50", () => {
    const result = analyticsQuerySchema.safeParse({ topLimit: "50" });
    expect(result.success).toBe(true);
    expect(result.data.topLimit).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// validateQuery() middleware
// ---------------------------------------------------------------------------

describe("validateQuery() middleware", () => {
  test("calls next() and replaces req.query with coerced values on valid input", () => {
    const middleware = validateQuery(paginationSchema);
    const req = mockReq({ limit: "20", offset: "5" });
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.query).toEqual({ limit: 20, offset: 5 });
  });

  test("applies schema defaults when params are absent", () => {
    const middleware = validateQuery(paginationSchema);
    const req = mockReq({});
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.query).toEqual({ limit: 10, offset: 0 });
  });

  test("returns 400 and does not call next() on invalid input", () => {
    const middleware = validateQuery(paginationSchema);
    const req = mockReq({ limit: "999" }); // exceeds max 100
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({
      code: "validation_failed",
      details: expect.arrayContaining([
        expect.objectContaining({ field: "limit" }),
      ]),
    });
  });

  test("returns 400 with field-level errors for multiple violations", () => {
    const middleware = validateQuery(paginationSchema);
    const req = mockReq({ limit: "0", offset: "-5" }); // both invalid
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    const fields = res._body.details.map((e) => e.field);
    expect(fields).toContain("limit");
    expect(fields).toContain("offset");
  });
});

// ---------------------------------------------------------------------------
// parsePagination() — backward-compat helper
// ---------------------------------------------------------------------------

describe("parsePagination()", () => {
  test("returns defaults when no query params provided", () => {
    const res = mockRes();
    const result = parsePagination({}, res, 50, 100);
    expect(result).toEqual({ limit: 50, offset: 0 });
  });

  test("clamps limit to maxLimit", () => {
    const res = mockRes();
    const result = parsePagination({ limit: "200" }, res, 50, 100);
    expect(result).toEqual({ limit: 100, offset: 0 });
  });

  test("uses defaultLimit when limit=0 (falsy, treated as omitted)", () => {
    const res = mockRes();
    // parseInt("0") || 50 → 50 (0 is falsy); the clamp then keeps 50
    const result = parsePagination({ limit: "0" }, res, 50, 100);
    expect(result).toEqual({ limit: 50, offset: 0 });
  });

  test("clamps negative offset to 0", () => {
    const res = mockRes();
    const result = parsePagination({ offset: "-10" }, res, 50, 100);
    expect(result).toEqual({ limit: 50, offset: 0 });
  });

  test("returns null and sends 400 for non-numeric limit", () => {
    const res = mockRes();
    const result = parsePagination({ limit: "abc" }, res, 50, 100);
    expect(result).toBeNull();
    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ code: "invalid_query_parameter" });
  });

  test("returns null and sends 400 for non-numeric offset", () => {
    const res = mockRes();
    const result = parsePagination({ offset: "xyz" }, res, 50, 100);
    expect(result).toBeNull();
    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ code: "invalid_query_parameter" });
  });

  test("accepts valid limit and offset together", () => {
    const res = mockRes();
    const result = parsePagination({ limit: "25", offset: "75" }, res, 50, 100);
    expect(result).toEqual({ limit: 25, offset: 75 });
  });
});
