/**
 * Validation helpers for Stellar addresses.
 *
 * - Contract addresses: "C" + 55 base32 chars = 56 total
 * - Account (public key) addresses: "G" + 55 base32 chars = 56 total
 *
 * Both follow the same StrKey encoding — only the prefix differs.
 */

/** StrKey contract-address shape: "C" + 55 base32 chars (A-Z, 2-7). */
export const CONTRACT_ADDRESS_REGEX = /^C[A-Z2-7]{55}$/;

/** StrKey account-address shape: "G" + 55 base32 chars (A-Z, 2-7). */
export const ACCOUNT_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

/** Any valid Stellar address (contract or account). */
export const STELLAR_ADDRESS_REGEX = /^[CG][A-Z2-7]{55}$/;

export const CONTRACT_ADDRESS_LENGTH = 56;

/** Human-readable error message for an invalid contract address. */
export const INVALID_CONTRACT_ADDRESS_MESSAGE =
  "Must be a valid Stellar C-address (56 chars)";

/** Human-readable error message for any invalid Stellar address. */
export const INVALID_STELLAR_ADDRESS_MESSAGE =
  "Must be a valid Stellar address (C... or G..., 56 chars)";

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
 * Returns true if `value` is a structurally valid Stellar account address (G...).
 */
export function isValidAccountAddress(value: string): boolean {
  return ACCOUNT_ADDRESS_REGEX.test(value.trim());
}

/**
 * Returns true if `value` is a valid Stellar address of any type (C... or G...).
 */
export function isValidStellarAddress(value: string): boolean {
  return STELLAR_ADDRESS_REGEX.test(value.trim());
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

/**
 * Returns an error message if `value` is not a valid Stellar address (any type),
 * or null for empty / valid input.
 */
export function getStellarAddressError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return isValidStellarAddress(trimmed) ? null : INVALID_STELLAR_ADDRESS_MESSAGE;
}

/**
 * Truncates a Stellar address for display: first 4 chars + "…" + last 4 chars.
 * Returns the original string if shorter than 12 chars.
 */
export function truncateStellarAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}
