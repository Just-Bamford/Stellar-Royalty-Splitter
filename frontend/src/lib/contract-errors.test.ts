/**
 * Frontend contract-error extraction tests (#677).
 * Error codes match the `ContractError` enum in `src/lib.rs`.
 */

import { describe, test, expect } from "vitest";
import {
  CONTRACT_ERROR_MESSAGES,
  extractContractError,
  formatErrorForToast,
} from "./contract-errors";

describe("CONTRACT_ERROR_MESSAGES map (#677)", () => {
  test("code 1 maps to Underfunded", () => {
    expect(CONTRACT_ERROR_MESSAGES[1]).toContain("insufficient");
  });

  test("code 2 maps to AlreadyInitialized", () => {
    expect(CONTRACT_ERROR_MESSAGES[2]).toContain("already been initialized");
  });

  test("code 6 maps to InvalidShareTotal", () => {
    expect(CONTRACT_ERROR_MESSAGES[6]).toContain("10,000 basis points");
  });

  test("code 8 maps to DuplicateRecipient", () => {
    expect(CONTRACT_ERROR_MESSAGES[8]).toContain("Duplicate");
  });

  test("code 16 maps to ContractPaused", () => {
    expect(CONTRACT_ERROR_MESSAGES[16]).toContain("paused");
  });

  test("code 26 maps to SalePriceNotPositive", () => {
    expect(CONTRACT_ERROR_MESSAGES[26]).toContain("Sale price");
  });

  test("code 32 maps to TooManyBatchTokens (#744)", () => {
    expect(CONTRACT_ERROR_MESSAGES[32]).toContain("maximum allowed number of tokens");
  });

  test("code 33 maps to RoyaltyAmountNotPositive (#744)", () => {
    expect(CONTRACT_ERROR_MESSAGES[33]).toContain("Royalty amount");
  });

  test("all 27 sequential codes are documented", () => {
    for (let i = 1; i <= 27; i++) {
      expect(CONTRACT_ERROR_MESSAGES[i]).toBeDefined();
    }
  });

  test("codes 32 and 33 (#744) are documented", () => {
    for (const code of [32, 33]) {
      expect(CONTRACT_ERROR_MESSAGES[code]).toBeDefined();
    }
  });

  test("code 34 maps to NoPendingAdminRotation (#778)", () => {
    expect(CONTRACT_ERROR_MESSAGES[34]).toContain("rotation");
  });

  test("code 35 maps to AdminRotationTimelockNotElapsed (#778)", () => {
    expect(CONTRACT_ERROR_MESSAGES[35]).toContain("timelock");
  });

  test("code 36 maps to InvalidTimelockDuration (#778)", () => {
    expect(CONTRACT_ERROR_MESSAGES[36]).toContain("timelock");
  });

  test("codes 34-36 (#778) are documented", () => {
    for (const code of [34, 35, 36]) {
      expect(CONTRACT_ERROR_MESSAGES[code]).toBeDefined();
    }
  });

  test("code 37 maps to EmergencyContractPaused (#779)", () => {
    expect(CONTRACT_ERROR_MESSAGES[37]).toContain("emergency pause");
  });

  test("code 38 maps to InvalidAnomalyThreshold (#779)", () => {
    expect(CONTRACT_ERROR_MESSAGES[38]).toContain("Anomaly threshold");
  });

  test("codes 37-38 (#779) are documented", () => {
    for (const code of [37, 38]) {
      expect(CONTRACT_ERROR_MESSAGES[code]).toBeDefined();
    }
  });
});

describe("extractContractError (#677)", () => {
  test("parses Soroban SDK panic shape and maps code 2 (AlreadyInitialized)", () => {
    const out = extractContractError("Error(Contract, #2)");
    expect(out.code).toBe(2);
    expect(out.message).toContain(CONTRACT_ERROR_MESSAGES[2]);
    expect(out.message).toContain("code 2");
  });

  test("maps code 16 (ContractPaused) correctly", () => {
    const out = extractContractError("Error(Contract, #16)");
    expect(out.code).toBe(16);
    expect(out.message).toContain(CONTRACT_ERROR_MESSAGES[16]);
  });

  test("falls back to raw message when the code is unknown (>27)", () => {
    const out = extractContractError("Error(Contract, #999)");
    expect(out.code).toBe(999);
    expect(out.message).toContain("code 999");
  });

  test("parses `code=N` style backend messages for code 6 (InvalidShareTotal)", () => {
    const out = extractContractError("contract panic; code=6; shares invalid");
    expect(out.code).toBe(6);
    expect(out.message).toContain(CONTRACT_ERROR_MESSAGES[6]);
  });

  test("unwraps an Error instance's message for code 8 (DuplicateRecipient)", () => {
    const err = new Error("Error(Contract, #8)");
    const out = extractContractError(err);
    expect(out.code).toBe(8);
    expect(out.message).toContain(CONTRACT_ERROR_MESSAGES[8]);
  });

  test("reads a structured object payload for code 1 (Underfunded)", () => {
    const out = extractContractError({
      code: 1,
      message: "No balance to distribute",
      details: "top up the contract first",
    });
    expect(out.code).toBe(1);
    expect(out.message).toContain(CONTRACT_ERROR_MESSAGES[1]);
    expect(out.details).toBe("top up the contract first");
  });

  test("maps code 26 (SalePriceNotPositive) from structured object", () => {
    const out = extractContractError({ code: 26, message: "sale price error" });
    expect(out.code).toBe(26);
    expect(out.message).toContain(CONTRACT_ERROR_MESSAGES[26]);
  });

  test("returns 'Unknown error' on null / undefined", () => {
    expect(extractContractError(null).message).toBe("Unknown error");
    expect(extractContractError(undefined).message).toBe("Unknown error");
  });

  test("maps code 10 (NotInitialized)", () => {
    const out = extractContractError("Error(Contract, #10)");
    expect(out.code).toBe(10);
    expect(out.message).toContain(CONTRACT_ERROR_MESSAGES[10]);
  });

  test("maps code 27 (InputTooLarge)", () => {
    const out = extractContractError("Error(Contract, #27)");
    expect(out.code).toBe(27);
    expect(out.message).toContain(CONTRACT_ERROR_MESSAGES[27]);
  });
});

describe("formatErrorForToast (#677)", () => {
  test("returns formatted message for code 2 (AlreadyInitialized)", () => {
    expect(formatErrorForToast("Error(Contract, #2)")).toContain(
      CONTRACT_ERROR_MESSAGES[2],
    );
  });

  test("returns formatted message for code 16 (ContractPaused)", () => {
    expect(formatErrorForToast("Error(Contract, #16)")).toContain(
      CONTRACT_ERROR_MESSAGES[16],
    );
  });

  test("returns raw message for an unrecognised error string", () => {
    const msg = formatErrorForToast("something went wrong");
    expect(msg).toBe("something went wrong");
  });
});
