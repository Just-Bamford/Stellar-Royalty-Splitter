/**
 * Pagination and analytics query validation tests (issue #394).
 */
import { describe, test, expect } from "@jest/globals";
import {
  paginationQuerySchema,
  analyticsQuerySchema,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  PAGINATION_MAX_OFFSET,
} from "../src/validation.js";

describe("paginationQuerySchema (issue #394)", () => {
  test("defaults: limit=10, offset=0 when omitted", () => {
    const result = paginationQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(PAGINATION_DEFAULT_LIMIT);
    expect(result.data.offset).toBe(0);
  });

  test("valid: limit=50, offset=100", () => {
    const result = paginationQuerySchema.safeParse({ limit: "50", offset: "100" });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ limit: 50, offset: 100 });
  });

  test("rejects limit=0", () => {
    const result = paginationQuerySchema.safeParse({ limit: "0" });
    expect(result.success).toBe(false);
  });

  test("rejects limit above max (101)", () => {
    const result = paginationQuerySchema.safeParse({ limit: "101" });
    expect(result.success).toBe(false);
    const msg = result.error.issues.map((i) => i.message).join(" ");
    expect(msg).toMatch(/100/);
  });

  test("accepts limit at max boundary (100)", () => {
    const result = paginationQuerySchema.safeParse({ limit: "100" });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(PAGINATION_MAX_LIMIT);
  });

  test("rejects negative offset", () => {
    const result = paginationQuerySchema.safeParse({ offset: "-1" });
    expect(result.success).toBe(false);
  });

  test("rejects non-integer limit", () => {
    const result = paginationQuerySchema.safeParse({ limit: "abc" });
    expect(result.success).toBe(false);
  });

  test("rejects offset above max", () => {
    const result = paginationQuerySchema.safeParse({
      offset: String(PAGINATION_MAX_OFFSET + 1),
    });
    expect(result.success).toBe(false);
  });

  test("rejects float limit (coerced then fails int check)", () => {
    const result = paginationQuerySchema.safeParse({ limit: "10.5" });
    expect(result.success).toBe(false);
  });
});

describe("analyticsQuerySchema (issue #394)", () => {
  test("defaults collaboratorLimit when omitted", () => {
    const result = analyticsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data.collaboratorLimit).toBe(10);
  });

  test("valid collaboratorLimit within bounds", () => {
    const result = analyticsQuerySchema.safeParse({ collaboratorLimit: "25" });
    expect(result.success).toBe(true);
    expect(result.data.collaboratorLimit).toBe(25);
  });

  test("rejects collaboratorLimit above 100", () => {
    const result = analyticsQuerySchema.safeParse({ collaboratorLimit: "500" });
    expect(result.success).toBe(false);
  });

  test("accepts optional start and end dates", () => {
    const result = analyticsQuerySchema.safeParse({
      start: "2024-01-01",
      end: "2024-12-31",
    });
    expect(result.success).toBe(true);
  });
});
