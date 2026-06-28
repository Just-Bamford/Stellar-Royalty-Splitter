/**
 * Frontend contract-error extraction tests (#279).
 */

import { describe, test, expect } from "vitest";
import {
  CONTRACT_ERROR_MESSAGES,
  extractContractError,
  formatErrorForToast,
} from "./contract-errors";

describe("extractContractError (#279)", () => {
  test("parses the Soroban SDK panic shape and maps known codes", () => {
    const out = extractContractError("Error(Contract, #2)");
    expect(out.code).toBe(2);
    expect(out.message).toContain(CONTRACT_ERROR_MESSAGES[2]);
    expect(out.message).toContain("code 2");
  });

  test("falls back to the raw message when the code is unknown", () => {
    const out = extractContractError("Error(Contract, #999)");
    expect(out.code).toBe(999);
    expect(out.message).toContain("code 999");
  });

  test("parses `code=N` style backend messages", () => {
    const out = extractContractError("contract panic; code=7; ...");
    expect(out.code).toBe(7);
    expect(out.message).toContain(CONTRACT_ERROR_MESSAGES[7]);
  });

  test("unwraps an Error instance's message", () => {
    const err = new Error("Error(Contract, #4)");
    const out = extractContractError(err);
    expect(out.code).toBe(4);
    expect(out.message).toContain(CONTRACT_ERROR_MESSAGES[4]);
  });

  test("reads a structured object payload", () => {
    const out = extractContractError({
      code: 8,
      message: "Contract paused at block 12345",
      details: "see ContractAdmin.pause()",
    });
    expect(out.code).toBe(8);
    expect(out.message).toContain(CONTRACT_ERROR_MESSAGES[8]);
    expect(out.details).toBe("see ContractAdmin.pause()");
  });

  test("returns 'Unknown error' on null / undefined", () => {
    expect(extractContractError(null).message).toBe("Unknown error");
    expect(extractContractError(undefined).message).toBe("Unknown error");
  });
});

describe("formatErrorForToast (#279)", () => {
  test("returns the formatted message ready for a toast call site", () => {
    expect(formatErrorForToast("Error(Contract, #3)")).toContain(
      CONTRACT_ERROR_MESSAGES[3],
    );
  });
});
