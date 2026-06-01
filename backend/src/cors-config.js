// CORS config helpers (#276).
//
// Goals (from the issue acceptance criteria):
//   - CORS origin is configurable via env var.
//   - Production uses a specific frontend origin.
//   - Development allows `*`.
//   - Validation rejects malformed values so a typo can't accidentally
//     widen the policy.

const DEV_NODE_ENVS = new Set(["development", "test"]);
const STAR = "*";

/**
 * Returns true when the given env value is considered "development-ish".
 * Falsy values default to production semantics so a misconfigured
 * deployment can never accidentally allow `*`.
 */
export function isDevEnv(nodeEnv = process.env.NODE_ENV) {
  return DEV_NODE_ENVS.has((nodeEnv ?? "production").toLowerCase());
}

/**
 * Validate a single CORS origin value. Throws when the value is
 * malformed or `*` is used in production.
 *
 *   - In development, `*` is allowed and any well-formed URL is allowed.
 *   - In production, `*` is rejected and the origin must be an http(s) URL.
 */
export function validateCorsOrigin(origin, { dev } = { dev: isDevEnv() }) {
  if (typeof origin !== "string" || origin.length === 0) {
    throw new Error("CORS origin must be a non-empty string");
  }
  if (origin === STAR) {
    if (dev) return origin;
    throw new Error(
      "CORS origin '*' is not allowed in production. Set FRONTEND_ORIGIN to your frontend's exact http(s) URL."
    );
  }
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("CORS origin must use http or https");
    }
  } catch (err) {
    throw new Error(`CORS origin is not a valid URL: ${origin} (${err.message})`);
  }
  return origin;
}

/**
 * Resolve the effective CORS origin from `FRONTEND_ORIGIN`, applying
 * environment-aware defaults:
 *   - dev / test → default to `*` so iterating from any localhost port works.
 *   - production → REQUIRE FRONTEND_ORIGIN; refuse to start otherwise.
 */
export function resolveCorsOrigin({
  envOrigin = process.env.FRONTEND_ORIGIN,
  dev = isDevEnv(),
} = {}) {
  if (!envOrigin) {
    if (dev) return STAR;
    throw new Error(
      "FRONTEND_ORIGIN is required in production. Set it to your frontend's exact http(s) URL."
    );
  }
  return validateCorsOrigin(envOrigin, { dev });
}
