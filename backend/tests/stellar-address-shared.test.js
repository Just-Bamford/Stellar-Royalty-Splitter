import {
  getStellarAccountAddressError,
  isValidStellarAccountAddress,
  STELLAR_ACCOUNT_ADDRESS_LENGTH,
} from "../../shared/stellar-address.js";
import { VALID_WALLET_A } from "./test-helpers.js";

describe("shared Stellar account address validation", () => {
  test("accepts a checksum-valid account address", () => {
    expect(VALID_WALLET_A).toHaveLength(STELLAR_ACCOUNT_ADDRESS_LENGTH);
    expect(isValidStellarAccountAddress(VALID_WALLET_A)).toBe(true);
  });

  test("rejects a regex-shaped address with an invalid checksum", () => {
    expect(isValidStellarAccountAddress(`G${"A".repeat(55)}`)).toBe(false);
  });

  test("rejects contract addresses for account fields", () => {
    expect(isValidStellarAccountAddress(`C${"A".repeat(55)}`)).toBe(false);
  });

  test("returns null error for empty input so required checks can own that message", () => {
    expect(getStellarAccountAddressError("")).toBeNull();
  });
});
