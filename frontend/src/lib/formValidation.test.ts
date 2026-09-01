/**
 * Unit tests for progressive form validation utilities.
 *
 * Run with: cd frontend && npx vitest run src/lib/formValidation.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  formatBasisPoints,
  parseFormattedBasisPoints,
  getAccountAddressError,
  isValidAccountAddress,
  getContractAddressValidationError,
  getPercentageValidationError,
  getAmountValidationError,
  getFieldState,
  getFieldInputClass,
  getAriaInvalid,
  INVALID_ACCOUNT_ADDRESS_MESSAGE,
  INVALID_CONTRACT_ADDRESS_MESSAGE,
} from "./formValidation";

// ── formatBasisPoints ────────────────────────────────────────────────────────

describe("formatBasisPoints", () => {
  it("returns empty string for empty input", () => {
    expect(formatBasisPoints("")).toBe("");
  });

  it("formats whole numbers with commas", () => {
    expect(formatBasisPoints("5000")).toBe("5,000");
    expect(formatBasisPoints("10000")).toBe("10,000");
    expect(formatBasisPoints("1234567")).toBe("1,234,567");
  });

  it("preserves decimal portions", () => {
    expect(formatBasisPoints("1234.5")).toBe("1,234.5");
    expect(formatBasisPoints("0.01")).toBe("0.01");
  });

  it("returns original value for non-numeric input", () => {
    expect(formatBasisPoints("abc")).toBe("abc");
  });

  it("handles single digit", () => {
    expect(formatBasisPoints("5")).toBe("5");
  });

  it("handles zero", () => {
    expect(formatBasisPoints("0")).toBe("0");
  });
});

// ── parseFormattedBasisPoints ────────────────────────────────────────────────

describe("parseFormattedBasisPoints", () => {
  it("removes commas", () => {
    expect(parseFormattedBasisPoints("5,000")).toBe("5000");
    expect(parseFormattedBasisPoints("1,234,567")).toBe("1234567");
  });

  it("handles values without commas", () => {
    expect(parseFormattedBasisPoints("5000")).toBe("5000");
  });

  it("preserves decimals", () => {
    expect(parseFormattedBasisPoints("1,234.5")).toBe("1234.5");
  });
});

// ── getAccountAddressError ───────────────────────────────────────────────────

describe("getAccountAddressError", () => {
  const VALID_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

  it("returns null for empty string", () => {
    expect(getAccountAddressError("")).toBeNull();
  });

  it("returns null for valid Stellar address", () => {
    expect(getAccountAddressError(VALID_ADDRESS)).toBeNull();
  });

  it("returns error for address starting with C", () => {
    expect(getAccountAddressError("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(
      INVALID_ACCOUNT_ADDRESS_MESSAGE,
    );
  });

  it("returns error for too-short address", () => {
    expect(getAccountAddressError("GAAZI4TCR3TY")).toBe(INVALID_ACCOUNT_ADDRESS_MESSAGE);
  });

  it("returns error for address with lowercase", () => {
    expect(getAccountAddressError("gAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA")).toBe(
      INVALID_ACCOUNT_ADDRESS_MESSAGE,
    );
  });

  it("trims whitespace before validating", () => {
    expect(getAccountAddressError(`  ${VALID_ADDRESS}  `)).toBeNull();
  });
});

// ── isValidAccountAddress ────────────────────────────────────────────────────

describe("isValidAccountAddress", () => {
  const VALID_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

  it("returns true for valid address", () => {
    expect(isValidAccountAddress(VALID_ADDRESS)).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isValidAccountAddress("")).toBe(false);
  });

  it("returns false for invalid address", () => {
    expect(isValidAccountAddress("GSHORT")).toBe(false);
  });
});

// ── getContractAddressValidationError ────────────────────────────────────────

describe("getContractAddressValidationError", () => {
  const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  it("returns null for empty string", () => {
    expect(getContractAddressValidationError("")).toBeNull();
  });

  it("returns null for valid contract address", () => {
    expect(getContractAddressValidationError(VALID_CONTRACT)).toBeNull();
  });

  it("returns error for account address (G...)", () => {
    expect(
      getContractAddressValidationError(
        "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
      ),
    ).toBe(INVALID_CONTRACT_ADDRESS_MESSAGE);
  });

  it("returns error for too-short value", () => {
    expect(getContractAddressValidationError("CAAAAA")).toBe(
      INVALID_CONTRACT_ADDRESS_MESSAGE,
    );
  });
});

// ── getPercentageValidationError ─────────────────────────────────────────────

describe("getPercentageValidationError", () => {
  it("returns required error for empty string", () => {
    expect(getPercentageValidationError("")).toBe("Percentage is required.");
  });

  it("returns error for negative values", () => {
    expect(getPercentageValidationError("-5")).toBe(
      "Percentage must be between 0 and 100.",
    );
  });

  it("returns error for values over 100", () => {
    expect(getPercentageValidationError("150")).toBe(
      "Percentage must be between 0 and 100.",
    );
  });

  it("returns error for non-numeric input", () => {
    expect(getPercentageValidationError("abc")).toBe("Percentage must be a number.");
  });

  it("returns null for valid percentages", () => {
    expect(getPercentageValidationError("0")).toBeNull();
    expect(getPercentageValidationError("50")).toBeNull();
    expect(getPercentageValidationError("100")).toBeNull();
    expect(getPercentageValidationError("33.33")).toBeNull();
  });

  it("returns null for decimal input that is valid", () => {
    expect(getPercentageValidationError("0.5")).toBeNull();
    expect(getPercentageValidationError("99.99")).toBeNull();
  });
});

// ── getAmountValidationError ─────────────────────────────────────────────────

describe("getAmountValidationError", () => {
  it("returns required error for empty string", () => {
    expect(getAmountValidationError("")).toBe("Amount is required.");
  });

  it("returns required error for whitespace only", () => {
    expect(getAmountValidationError("  ")).toBe("Amount is required.");
  });

  it("returns error for zero", () => {
    expect(getAmountValidationError("0")).toBe("Enter a valid positive amount.");
  });

  it("returns error for negative values", () => {
    expect(getAmountValidationError("-10")).toBe("Enter a valid positive amount.");
  });

  it("returns error for non-numeric input", () => {
    expect(getAmountValidationError("abc")).toBe("Enter a valid positive amount.");
  });

  it("returns null for valid amounts", () => {
    expect(getAmountValidationError("1")).toBeNull();
    expect(getAmountValidationError("100.5")).toBeNull();
    expect(getAmountValidationError("1000000000")).toBeNull();
  });
});

// ── getFieldState ────────────────────────────────────────────────────────────

describe("getFieldState", () => {
  it("returns idle when not touched", () => {
    expect(getFieldState(false, null)).toBe("idle");
    expect(getFieldState(false, "error")).toBe("idle");
  });

  it("returns valid when touched and no error", () => {
    expect(getFieldState(true, null)).toBe("valid");
  });

  it("returns error when touched and has error", () => {
    expect(getFieldState(true, "some error")).toBe("error");
  });
});

// ── getFieldInputClass ───────────────────────────────────────────────────────

describe("getFieldInputClass", () => {
  it("returns empty string for idle", () => {
    expect(getFieldInputClass("idle")).toBe("");
  });

  it("returns input-valid for valid", () => {
    expect(getFieldInputClass("valid")).toBe("input-valid");
  });

  it("returns input-error for error", () => {
    expect(getFieldInputClass("error")).toBe("input-error");
  });
});

// ── getAriaInvalid ───────────────────────────────────────────────────────────

describe("getAriaInvalid", () => {
  it("returns 'true' for error state", () => {
    expect(getAriaInvalid("error")).toBe("true");
  });

  it("returns undefined for idle state", () => {
    expect(getAriaInvalid("idle")).toBeUndefined();
  });

  it("returns undefined for valid state", () => {
    expect(getAriaInvalid("valid")).toBeUndefined();
  });
});
