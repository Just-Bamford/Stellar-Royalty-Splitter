import { StrKey } from "@stellar/stellar-sdk";

export const STELLAR_ACCOUNT_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;
export const STELLAR_ACCOUNT_ADDRESS_LENGTH = 56;
export const INVALID_STELLAR_ACCOUNT_ADDRESS_MESSAGE =
  "Must be a valid Stellar account address (G..., 56 chars)";

export function normalizeStellarAccountAddress(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function isValidStellarAccountAddress(value) {
  const address = normalizeStellarAccountAddress(value);
  if (!STELLAR_ACCOUNT_ADDRESS_REGEX.test(address)) return false;
  return StrKey.isValidEd25519PublicKey(address);
}

export function getStellarAccountAddressError(value) {
  const address = normalizeStellarAccountAddress(value);
  if (!address) return null;
  return isValidStellarAccountAddress(address)
    ? null
    : INVALID_STELLAR_ACCOUNT_ADDRESS_MESSAGE;
}
