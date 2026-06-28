/**
 * Validation helpers for Stellar contract ("C...") addresses.
 *
 * A Stellar contract address is a StrKey-encoded value beginning with "C"
 * followed by 55 base32 characters (RFC 4648 alphabet, no padding), for a
 * total length of 56. This mirrors the existing `C_ADDR` check in
 * RecordSecondarySale.tsx, centralised here so the format lives in one place.
 */

/** StrKey contract-address shape: "C" + 55 base32 chars (A-Z, 2-7). */
export const CONTRACT_ADDRESS_REGEX = /^C[A-Z2-7]{55}$/;

export const CONTRACT_ADDRESS_LENGTH = 56;

/** Human-readable error message for an invalid contract address. */
export const INVALID_CONTRACT_ADDRESS_MESSAGE =
  "Must be a valid Stellar C-address (56 chars)";

/**
 * Returns true if `value` is a structurally valid Stellar contract address.
 *
 * This validates format only (prefix, length, base32 alphabet); it does not
 * verify the StrKey checksum or that the contract exists on-chain.
 */
export function isValidContractAddress(value: string): boolean {
  return CONTRACT_ADDRESS_REGEX.test(value.trim());
}

/**
 * Returns an error message for `value`, or null when it is acceptable.
 *
 * An empty string returns null so that callers can show a "required" message
 * separately and avoid flagging an untouched field as malformed.
 */
export function getContractAddressError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return isValidContractAddress(trimmed) ? null : INVALID_CONTRACT_ADDRESS_MESSAGE;
}
