/**
 * Validation helpers for form input validation.
 * Provides utilities for Stellar address validation and other form validators.
 */

import { StrKey } from "@stellar/stellar-sdk";

/**
 * Validates a Stellar public key address (starts with "G").
 * Uses the official StrKey validator from the Stellar SDK.
 */
export function isValidStellarAddress(address: string): boolean {
  if (typeof address !== "string") {
    return false;
  }
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

/**
 * Validates a percentage value is between 0 and 100 (exclusive of 0).
 */
export function isValidPercentage(value: number): boolean {
  return typeof value === "number" && value > 0 && value <= 100;
}

/**
 * Validates that a share is valid (number between 0.01 and 100).
 */
export function isValidShare(value: number): boolean {
  return typeof value === "number" && value >= 0.01 && value <= 100;
}
