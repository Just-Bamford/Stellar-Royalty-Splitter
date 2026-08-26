/**
 * Contract error extraction + mapping (#279).
 *
 * Soroban contract invocations carry useful failure detail in their
 * error payload, but the frontend was throwing a generic
 * "Request failed" / "transaction failed" — operators had no idea
 * which guard rail tripped.
 *
 * This module:
 *   - extracts a structured `{ code, message, details }` triple from
 *     whatever the backend returned (Error / Response body / string),
 *   - maps the contract's documented numeric error codes to
 *     human-friendly messages so the toast surfaces *what* went wrong,
 *     not just *that* it went wrong.
 *
 * The mapping table is intentionally small — extend it as new error
 * variants land in `src/errors.rs`.
 */

export interface ExtractedError {
  /**
   * Best-effort numeric / string code from the backend payload, or
   * `null` when nothing parseable was present.
   */
  code: string | number | null;
  /** Human-friendly headline for the toast. */
  message: string;
  /** Raw detail string (stack / contract panic / etc.) for "show more". */
  details?: string;
}

/**
 * Numeric → user-friendly message map. Codes match the `ContractError`
 * variants defined in `src/lib.rs` of the on-chain contract (repr u32,
 * starting at 1). See `docs/CONTRACT_ERRORS.md` for the full reference
 * including trigger conditions and recommended client-side handling.
 */
export const CONTRACT_ERROR_MESSAGES: Record<number, string> = {
  1:  "Contract has insufficient token balance to distribute.",
  2:  "Contract has already been initialized.",
  3:  "Collaborator list cannot be empty.",
  4:  "Recipient count exceeds the maximum allowed.",
  5:  "Collaborator and share lists must be the same length.",
  6:  "Shares must sum to exactly 10,000 basis points (100%).",
  7:  "Each collaborator must have a share greater than zero.",
  8:  "Duplicate address found in recipient list.",
  9:  "Share value exceeds 10,000 basis points.",
  10: "Contract has not been initialized.",
  11: "No collaborators are registered on this contract.",
  12: "Share map is missing; the contract may need re-initialization.",
  13: "Arithmetic overflow during payout calculation.",
  14: "Royalty rate cannot be zero.",
  15: "Royalty rate exceeds 10,000 basis points (100%).",
  16: "Contract is paused; distributions are temporarily halted.",
  17: "Withdrawal amount must be greater than zero.",
  18: "Contract balance is insufficient for the requested withdrawal.",
  19: "Recipient list is empty; configure recipients before distributing.",
  20: "Balance is too small to distribute at least 1 stroop to each recipient.",
  21: "Secondary royalty pool exceeds the contract's token balance.",
  22: "No secondary royalties have been recorded to distribute.",
  23: "No secondary royalty token has been set.",
  24: "Address is not registered as a collaborator on this contract.",
  25: "Updated shares would not sum to 10,000 basis points.",
  26: "Sale price must be greater than zero.",
  27: "Input exceeds the maximum allowed size.",
  32: "Batch distribute cannot process more than the maximum allowed number of tokens in one call.",
  33: "Royalty amount must be greater than zero.",
  34: "No admin rotation is currently pending.",
  35: "Admin rotation timelock has not elapsed yet.",
  36: "Admin rotation timelock duration is outside the allowed range.",
};

/**
 * Pull the cleanest error code + message we can out of an arbitrary
 * thrown value. Safe to call from any `catch (e)` block.
 */
export function extractContractError(input: unknown): ExtractedError {
  if (input == null) {
    return { code: null, message: "Unknown error" };
  }
  if (typeof input === "string") {
    return parseErrorString(input);
  }
  if (input instanceof Error) {
    // The `Error` thrown by api.ts puts the backend's `data.error`
    // into `message`; parse it back into structured form.
    return parseErrorString(input.message);
  }
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const code = (obj.code ?? obj.errorCode ?? obj.status ?? null) as string | number | null;
    const message =
      (typeof obj.message === "string" && obj.message) ||
      (typeof obj.error === "string" && obj.error) ||
      "Unknown error";
    const details = typeof obj.details === "string" ? obj.details : undefined;
    return finalize({ code, message, details });
  }
  return { code: null, message: String(input) };
}

/**
 * Parse strings of the form `"Error(Contract, #7)"` or
 * `"contract error: ...; code=7"` that the backend forwards from
 * the SDK. Anything we can't parse becomes a vanilla message.
 */
function parseErrorString(raw: string): ExtractedError {
  const trimmed = raw.trim();
  // `Error(Contract, #7)` — Soroban SDK panic shape.
  const sdkMatch = trimmed.match(/Error\(Contract,\s*#(\d+)\)/i);
  if (sdkMatch) {
    const code = Number(sdkMatch[1]);
    return finalize({ code, message: trimmed });
  }
  // `code=7` / `code:7` — backend-friendly shape.
  const codeMatch = trimmed.match(/code\s*[=:]\s*(\d+)/i);
  if (codeMatch) {
    return finalize({ code: Number(codeMatch[1]), message: trimmed });
  }
  return finalize({ code: null, message: trimmed });
}

function finalize(input: ExtractedError): ExtractedError {
  const { code, message, details } = input;
  if (typeof code === "number" && CONTRACT_ERROR_MESSAGES[code]) {
    return {
      code,
      message: `${CONTRACT_ERROR_MESSAGES[code]} (code ${code})`,
      details: details ?? message,
    };
  }
  if (code !== null && code !== undefined) {
    return { code, message: `${message} (code ${code})`, details };
  }
  return { code: null, message, details };
}

/**
 * Convenience: format the toast string the rest of the UI shows.
 * Wraps `extractContractError` so call sites can stay one-liners:
 *
 *   showToast(formatErrorForToast(err));
 */
export function formatErrorForToast(input: unknown): string {
  return extractContractError(input).message;
}
