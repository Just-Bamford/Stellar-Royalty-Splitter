/**
 * Validation for the governance proposal creation form (#1375).
 *
 * Each action type needs different fields, and the form used to submit them
 * without checking, so a malformed rate, address or amount only failed later
 * (on-chain or in the API). `validateGovernanceProposal` returns a
 * human-readable message for the first problem, or `null` when the proposal is
 * ready to submit.
 */

import { isValidAccountAddress } from "./formValidation";
import { isValidContractAddress } from "./stellar-address";

export type GovernanceActionType =
  | "ChangeRoyaltyRate"
  | "SetTokenFeeOverride"
  | "PauseContract"
  | "UnpauseContract"
  | "RemoveCollaborator"
  | "AllocateBudget";

export interface GovernanceProposalFields {
  title: string;
  description: string;
  actionType: GovernanceActionType;
  newRate: string;
  tokenAddress: string;
  feeBps: string;
  collabAddress: string;
  budgetRecipient: string;
  budgetAmount: string;
}

/** Royalty rate bounds, in basis points. */
export const MIN_ROYALTY_RATE_BPS = 1;
export const MAX_BPS = 10_000;

/** Budget amounts are integers that must fit a signed 128-bit contract value. */
const MAX_I128 = (1n << 127n) - 1n;

const DIGITS_ONLY = /^\d+$/;

/** Parses a whole-number string, or returns null for anything else. */
function parseWholeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!DIGITS_ONLY.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

export const INVALID_CONTRACT_MESSAGE =
  "Token address must be a valid Stellar contract address (C…, 56 characters).";
export const INVALID_ACCOUNT_MESSAGE =
  "Address must be a valid Stellar account address (G…, 56 characters).";

function validateAction(f: GovernanceProposalFields): string | null {
  switch (f.actionType) {
    case "ChangeRoyaltyRate": {
      const rate = parseWholeNumber(f.newRate);
      if (rate === null || rate < MIN_ROYALTY_RATE_BPS || rate > MAX_BPS) {
        return `Royalty rate must be a whole number between ${MIN_ROYALTY_RATE_BPS} and ${MAX_BPS} basis points.`;
      }
      return null;
    }
    case "SetTokenFeeOverride": {
      if (!isValidContractAddress(f.tokenAddress)) return INVALID_CONTRACT_MESSAGE;
      const bps = parseWholeNumber(f.feeBps);
      if (bps === null || bps > MAX_BPS) {
        return `Fee must be a whole number between 0 and ${MAX_BPS} basis points.`;
      }
      return null;
    }
    case "RemoveCollaborator":
      return isValidAccountAddress(f.collabAddress)
        ? null
        : "Collaborator address must be a valid Stellar account address (G…, 56 characters).";
    case "AllocateBudget": {
      if (!isValidContractAddress(f.tokenAddress)) return INVALID_CONTRACT_MESSAGE;
      if (!isValidAccountAddress(f.budgetRecipient)) {
        return "Recipient must be a valid Stellar account address (G…, 56 characters).";
      }
      const amount = f.budgetAmount.trim();
      if (!DIGITS_ONLY.test(amount) || BigInt(amount) <= 0n) {
        return "Budget amount must be a positive whole number.";
      }
      if (BigInt(amount) > MAX_I128) return "Budget amount is too large.";
      return null;
    }
    case "PauseContract":
    case "UnpauseContract":
      return null;
    default:
      return "Unknown proposal action.";
  }
}

/**
 * Returns an error message for the first invalid field, or `null` when the
 * proposal can be submitted.
 */
export function validateGovernanceProposal(fields: GovernanceProposalFields): string | null {
  if (!fields.title.trim()) return "Title is required.";
  if (!fields.description.trim()) return "Description is required.";
  return validateAction(fields);
}
