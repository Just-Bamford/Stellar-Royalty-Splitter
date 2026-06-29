import { describe, test, expect } from "vitest";
import {
  isValidContractAddress,
  isValidAccountAddress,
  isValidStellarAddress,
  getContractAddressError,
  getStellarAddressError,
  truncateStellarAddress,
  CONTRACT_ADDRESS_REGEX,
  ACCOUNT_ADDRESS_REGEX,
  INVALID_CONTRACT_ADDRESS_MESSAGE,
  INVALID_STELLAR_ADDRESS_MESSAGE,
} from "./stellar-address";

// Valid addresses
const VALID_C_ADDRESS = "C" + "A".repeat(55);
const VALID_G_ADDRESS = "G" + "A".repeat(55);

describe("stellar contract address validation (#361)", () => {
  test("accepts a well-formed C-address", () => {
    expect(isValidContractAddress(VALID_C_ADDRESS)).toBe(true);
    expect(VALID_C_ADDRESS).toHaveLength(56);
    expect(CONTRACT_ADDRESS_REGEX.test(VALID_C_ADDRESS)).toBe(true);
  });

  test("rejects an address that is too short", () => {
    expect(isValidContractAddress("C" + "A".repeat(54))).toBe(false);
  });

  test("rejects an address that is too long", () => {
    expect(isValidContractAddress("C" + "A".repeat(56))).toBe(false);
  });

  test("rejects an address with the wrong prefix", () => {
    // Valid length, but begins with G (an account address, not a contract).
    expect(isValidContractAddress("G" + "A".repeat(55))).toBe(false);
  });

  test("rejects characters outside the base32 alphabet", () => {
    // '0', '1', '8', '9' are not in the RFC 4648 base32 alphabet.
    expect(isValidContractAddress("C" + "0".repeat(55))).toBe(false);
    expect(isValidContractAddress("C" + "1".repeat(55))).toBe(false);
    expect(isValidContractAddress("C" + "8".repeat(55))).toBe(false);
  });

  test("rejects lowercase characters", () => {
    expect(isValidContractAddress("c" + "a".repeat(55))).toBe(false);
  });

  test("rejects empty and whitespace-only input", () => {
    expect(isValidContractAddress("")).toBe(false);
    expect(isValidContractAddress("   ")).toBe(false);
  });

  test("trims surrounding whitespace before validating", () => {
    expect(isValidContractAddress(`  ${VALID_C_ADDRESS}  `)).toBe(true);
  });

  test("getContractAddressError returns null for empty input (handled as required separately)", () => {
    expect(getContractAddressError("")).toBeNull();
    expect(getContractAddressError("   ")).toBeNull();
  });

  test("getContractAddressError returns the message for malformed input", () => {
    expect(getContractAddressError("not-an-address")).toBe(
      INVALID_CONTRACT_ADDRESS_MESSAGE,
    );
  });

  test("getContractAddressError returns null for a valid address", () => {
    expect(getContractAddressError(VALID_C_ADDRESS)).toBeNull();
  });
});

describe("stellar account address validation (#479)", () => {
  test("accepts a well-formed G-address", () => {
    expect(isValidAccountAddress(VALID_G_ADDRESS)).toBe(true);
    expect(ACCOUNT_ADDRESS_REGEX.test(VALID_G_ADDRESS)).toBe(true);
  });

  test("rejects a C-address for account validation", () => {
    expect(isValidAccountAddress(VALID_C_ADDRESS)).toBe(false);
  });

  test("rejects wrong length G-address", () => {
    expect(isValidAccountAddress("G" + "A".repeat(54))).toBe(false);
    expect(isValidAccountAddress("G" + "A".repeat(56))).toBe(false);
  });
});

describe("isValidStellarAddress (#479)", () => {
  test("accepts C-address", () => {
    expect(isValidStellarAddress(VALID_C_ADDRESS)).toBe(true);
  });

  test("accepts G-address", () => {
    expect(isValidStellarAddress(VALID_G_ADDRESS)).toBe(true);
  });

  test("rejects other prefixes", () => {
    expect(isValidStellarAddress("S" + "A".repeat(55))).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidStellarAddress("")).toBe(false);
  });
});

describe("getStellarAddressError (#479)", () => {
  test("returns null for empty input", () => {
    expect(getStellarAddressError("")).toBeNull();
  });

  test("returns null for valid G-address", () => {
    expect(getStellarAddressError(VALID_G_ADDRESS)).toBeNull();
  });

  test("returns null for valid C-address", () => {
    expect(getStellarAddressError(VALID_C_ADDRESS)).toBeNull();
  });

  test("returns error message for invalid address", () => {
    expect(getStellarAddressError("invalid")).toBe(INVALID_STELLAR_ADDRESS_MESSAGE);
  });
});

describe("truncateStellarAddress (#479)", () => {
  test("truncates a long address to first-4 + last-4 by default", () => {
    const result = truncateStellarAddress(VALID_G_ADDRESS);
    expect(result).toBe(`${VALID_G_ADDRESS.slice(0, 4)}…${VALID_G_ADDRESS.slice(-4)}`);
  });

  test("returns original string when shorter than 2*chars+1", () => {
    expect(truncateStellarAddress("SHORT")).toBe("SHORT");
  });

  test("respects custom chars param", () => {
    const result = truncateStellarAddress(VALID_G_ADDRESS, 6);
    expect(result).toBe(`${VALID_G_ADDRESS.slice(0, 6)}…${VALID_G_ADDRESS.slice(-6)}`);
  });
});
