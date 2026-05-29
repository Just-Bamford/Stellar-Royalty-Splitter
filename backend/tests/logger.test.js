import { describe, test, expect } from "@jest/globals";
import { resolveLevel, VALID_LEVELS } from "../src/logger.js";

describe("resolveLevel (#278)", () => {
  test("defaults to info when LOG_LEVEL is unset", () => {
    expect(resolveLevel(undefined)).toBe("info");
  });

  test("recognises every valid level (case-insensitive)", () => {
    for (const level of VALID_LEVELS) {
      expect(resolveLevel(level)).toBe(level);
      expect(resolveLevel(level.toUpperCase())).toBe(level);
    }
  });

  test("falls back to info on a typo so logging never disappears entirely", () => {
    expect(resolveLevel("infooo")).toBe("info");
    expect(resolveLevel("trace")).toBe("info");
  });
});

describe("VALID_LEVELS (#278)", () => {
  test("matches the documented level hierarchy", () => {
    expect(VALID_LEVELS).toEqual(["error", "warn", "info", "debug"]);
  });
});
