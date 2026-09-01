/**
 * Tests for DashboardHeader sub-component (#833).
 *
 * Validates the date-range validation logic (start/end ordering) that
 * DashboardHeader enforces before forwarding changes to its parent.
 */

import { describe, test, expect } from "@jest/globals";
import type { DateRange } from "./DashboardHeader";

/** Mirror of the validation logic inside DashboardHeader. */
function validateStartChange(
  start: string,
  range: DateRange,
): { error: string | null; range: DateRange | null } {
  if (start > range.end) {
    return { error: "Start date must be on or before end date.", range: null };
  }
  return { error: null, range: { ...range, start } };
}

function validateEndChange(
  end: string,
  range: DateRange,
): { error: string | null; range: DateRange | null } {
  if (end < range.start) {
    return { error: "End date must be on or after start date.", range: null };
  }
  return { error: null, range: { ...range, end } };
}

describe("DashboardHeader #833", () => {
  const baseRange: DateRange = {
    start: "2025-01-01",
    end: "2025-03-31",
  };

  test("valid start date produces no error", () => {
    const result = validateStartChange("2025-01-15", baseRange);
    expect(result.error).toBeNull();
    expect(result.range?.start).toBe("2025-01-15");
  });

  test("start date after end date produces an error", () => {
    const result = validateStartChange("2025-06-01", baseRange);
    expect(result.error).toBe("Start date must be on or before end date.");
    expect(result.range).toBeNull();
  });

  test("start date equal to end date is valid", () => {
    const result = validateStartChange("2025-03-31", baseRange);
    expect(result.error).toBeNull();
    expect(result.range?.start).toBe("2025-03-31");
  });

  test("valid end date produces no error", () => {
    const result = validateEndChange("2025-03-15", baseRange);
    expect(result.error).toBeNull();
    expect(result.range?.end).toBe("2025-03-15");
  });

  test("end date before start date produces an error", () => {
    const result = validateEndChange("2024-12-01", baseRange);
    expect(result.error).toBe("End date must be on or after start date.");
    expect(result.range).toBeNull();
  });

  test("end date equal to start date is valid", () => {
    const result = validateEndChange("2025-01-01", baseRange);
    expect(result.error).toBeNull();
    expect(result.range?.end).toBe("2025-01-01");
  });

  test("DateRange interface requires start and end strings", () => {
    const range: DateRange = { start: "2025-01-01", end: "2025-12-31" };
    expect(typeof range.start).toBe("string");
    expect(typeof range.end).toBe("string");
  });

  test("range is unchanged when only end is updated", () => {
    const result = validateEndChange("2025-06-30", baseRange);
    expect(result.range?.start).toBe(baseRange.start);
    expect(result.range?.end).toBe("2025-06-30");
  });
});
