/**
 * Error-message sanitisation (#499)
 *
 * Backend and on-chain contract errors are surfaced verbatim in the UI. A
 * malicious or misconfigured contract could emit an error string containing
 * markup (`<script>`, `<img onerror=…>`, inline event handlers), so we never
 * trust that text. React already escapes string children, but we sanitise at
 * the source as defence-in-depth: tags and their bodies are stripped and any
 * stray angle brackets are removed so the result can only ever render as inert
 * plain text — equivalent to assigning via `textContent` rather than
 * `innerHTML`.
 */

const SCRIPT_BLOCK = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const STYLE_BLOCK = /<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi;
const HTML_TAG = /<\/?[a-z][\s\S]*?>/gi;

const MAX_LENGTH = 500;

/**
 * Returns a plain-text, render-safe version of an arbitrary error value.
 * Strips HTML tags (and `<script>`/`<style>` bodies), neutralises leftover
 * angle brackets, collapses whitespace and caps the length.
 */
export function sanitizeErrorMessage(input: unknown): string {
  const raw = typeof input === "string" ? input : String(input ?? "");

  return raw
    .replace(SCRIPT_BLOCK, "")
    .replace(STYLE_BLOCK, "")
    .replace(HTML_TAG, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LENGTH);
}
