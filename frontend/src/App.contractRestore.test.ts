import { describe, it, expect } from "vitest";
import { isValidContractId } from "./App";

describe("isValidContractId and contractId restore", () => {
  it("validates contract id format correctly", () => {
    expect(isValidContractId("")).toBe(false);
    expect(isValidContractId("G" + "A".repeat(55))).toBe(false);
    expect(isValidContractId("C" + "A".repeat(54))).toBe(false);
    expect(isValidContractId("C" + "A".repeat(56))).toBe(false);
    expect(isValidContractId("C" + "A".repeat(55))).toBe(true);
  });

  it("discards malformed lastContractId and preserves valid one", () => {
    const valid = "C" + "A".repeat(55);
    const checkRestore = (stored: string | null) => {
      const saved = stored ?? "";
      return isValidContractId(saved) ? saved : "";
    };

    expect(checkRestore(null)).toBe("");
    expect(checkRestore("")).toBe("");
    expect(checkRestore("malformed-id")).toBe("");
    expect(checkRestore("C_short")).toBe("");
    expect(checkRestore(valid)).toBe(valid);
  });
});
