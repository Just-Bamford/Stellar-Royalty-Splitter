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
 * Numeric → user-friendly message map. Codes match the variants in
 * `src/errors.rs` of the contract. Anything missing falls through to
 * the generic message but keeps the code visible in the toast.
 */
export const CONTRACT_ERROR_MESSAGES: Record<number, string> = {
  1: "Contract is already initialized.",
  2: "Caller is not the contract admin.",
  3: "Collaborator address is duplicated in the share split.",
  4: "Collaborator shares do not sum to 100%.",
  5: "Token id has already been distributed.",
  6: "Sale price must be greater than zero.",
  7: "Secondary royalty bps exceeds the configured cap.",
  8: "Contract is paused; please try again later.",
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
