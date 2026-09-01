/**
 * Progressive form validation utilities for Stellar Royalty Splitter.
 *
 * Provides blur-time validation, inline error messages, auto-formatting,
 * and field state helpers for InitializeForm and DistributeForm.
 */

// ── Basis points / percentage formatting ─────────────────────────────────────

/**
 * Format a numeric string as a display-friendly basis points value with commas.
 * Example: "5000" → "5,000" | "1234.5" → "1,234.5"
 * Returns the original value if it's not a valid number.
 */
export function formatBasisPoints(value: string): string {
  if (!value) return "";
  const num = Number(value);
  if (Number.isNaN(num)) return value;
  const parts = value.split(".");
  const integerPart = parseInt(parts[0], 10);
  if (Number.isNaN(integerPart)) return value;
  const formatted = integerPart.toLocaleString("en-US");
  return parts.length > 1 ? `${formatted}.${parts[1]}` : formatted;
}

/**
 * Parse a formatted basis points string back to a raw numeric string.
 * Example: "5,000" → "5000" | "1,234.5" → "1234.5"
 */
export function parseFormattedBasisPoints(value: string): string {
  return value.replace(/,/g, "");
}

// ── Stellar account address validation ───────────────────────────────────────

/** StrKey account-address shape: "G" + 55 base32 chars (A-Z, 2-7). */
const ACCOUNT_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export const INVALID_ACCOUNT_ADDRESS_MESSAGE =
  "Invalid Stellar address (must start with G and be 56 characters)";

/**
 * Validates a Stellar account address (G... format, 56 chars, base32 alphabet).
 * Returns null for empty strings (so untouched fields aren't flagged),
 * an error message for invalid values, or null for valid addresses.
 *
 * Note: This validates structural format only (prefix, length, alphabet).
 * Full StrKey checksum verification is done by the shared/stellar-address
 * module at runtime.
 */
export function getAccountAddressError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return ACCOUNT_ADDRESS_REGEX.test(trimmed) ? null : INVALID_ACCOUNT_ADDRESS_MESSAGE;
}

/**
 * Returns true if the value structurally matches a Stellar account address.
 */
export function isValidAccountAddress(value: string): boolean {
  return ACCOUNT_ADDRESS_REGEX.test(value.trim());
}

// ── Stellar contract address validation ──────────────────────────────────────

/** StrKey contract-address shape: "C" + 55 base32 chars (A-Z, 2-7). */
const CONTRACT_ADDRESS_REGEX = /^C[A-Z2-7]{55}$/;

export const INVALID_CONTRACT_ADDRESS_MESSAGE =
  "Invalid Stellar contract address (must start with C and be 56 characters)";

/**
 * Validates a Stellar contract address (C... format).
 * Returns null for empty strings, error for invalid, null for valid.
 */
export function getContractAddressValidationError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return CONTRACT_ADDRESS_REGEX.test(trimmed) ? null : INVALID_CONTRACT_ADDRESS_MESSAGE;
}

// ── Percentage / basis points validation ──────────────────────────────────────

const PERCENTAGE_INPUT_RE = /^(\d+(\.\d*)?|\.\d+)?$/;
const SIGNED_PERCENTAGE_RE = /^-(\d+(\.\d*)?|\.\d+)$/;

/**
 * Validate a percentage input (0–100 range, user-friendly messages).
 * Returns null for empty strings, an error message otherwise.
 */
export function getPercentageValidationError(value: string): string | null {
  if (!value) return "Percentage is required.";
  if (SIGNED_PERCENTAGE_RE.test(value))
    return "Percentage must be between 0 and 100.";
  if (!PERCENTAGE_INPUT_RE.test(value)) return "Percentage must be a number.";

  const num = Number(value);
  if (Number.isNaN(num)) return "Percentage must be a number.";
  if (num < 0 || num > 100) return "Percentage must be between 0 and 100.";
  return null;
}

// ── Amount validation ────────────────────────────────────────────────────────

/**
 * Validate a distribution amount.
 * Returns null for empty strings, an error message otherwise.
 */
export function getAmountValidationError(value: string): string | null {
  if (!value || !value.trim()) return "Amount is required.";
  const num = Number(value);
  if (Number.isNaN(num) || num <= 0) return "Enter a valid positive amount.";
  return null;
}

// ── Field state helpers ──────────────────────────────────────────────────────

export type FieldState = "idle" | "valid" | "error";

/**
 * Derive the visual state of a field based on whether it has been touched,
 * has an error, or is valid.
 */
export function getFieldState(
  touched: boolean,
  error: string | null,
): FieldState {
  if (!touched) return "idle";
  return error ? "error" : "valid";
}

/**
 * Returns the CSS class for an input based on its field state.
 */
export function getFieldInputClass(state: FieldState): string {
  switch (state) {
    case "valid":
      return "input-valid";
    case "error":
      return "input-error";
    default:
      return "";
  }
}

/**
 * Returns the aria-invalid attribute value for a field.
 */
export function getAriaInvalid(state: FieldState): "true" | undefined {
  return state === "error" ? "true" : undefined;
}
