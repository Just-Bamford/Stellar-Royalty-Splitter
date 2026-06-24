import { describe, test, expect } from "vitest";
import {
  isValidContractAddress,
  getContractAddressError,
  CONTRACT_ADDRESS_REGEX,
  INVALID_CONTRACT_ADDRESS_MESSAGE,
} from "./stellar-address";

// A structurally valid contract address: "C" + 55 base32 chars.
const VALID_C_ADDRESS = "C" + "A".repeat(55);

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
