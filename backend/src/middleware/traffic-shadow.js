/**
 * Traffic shadowing for canary deployments (#936).
 *
 * When SHADOW_TARGET_URL is set (the canary's address — on the same host as the
 * stable API, see docs/canary-deployment.md), a copy of each eligible request
 * is replayed against it after the real response has been sent. The client
 * only ever sees the stable response; the canary's answer is compared and
 * discarded. This exercises the new version with real production traffic
 * before any user is routed to it.
 *
 * Only safe, idempotent methods (GET/HEAD) are mirrored. The stable and canary
 * processes share one SQLite database, so replaying a POST would record every
 * distribution or sale twice.
 *
 *   SHADOW_TARGET_URL    e.g. http://127.0.0.1:3002 (unset = disabled)
 *   SHADOW_SAMPLE_RATE   0..1, fraction of eligible requests mirrored (default 1)
 *   SHADOW_TIMEOUT_MS    per mirrored request (default 5000)
 */

import { recordShadowRequest } from "../metrics.js";

export const SHADOW_HEADER = "x-shadow-request";
const SHADOWABLE_METHODS = new Set(["GET", "HEAD"]);
const EXCLUDED_PATH = /^\/(admin|metrics)(\/|$)|^\/api\/v1\/metrics(\/|$)/;
// Hop-by-hop and credential headers are not forwarded to the shadow target.
const FORWARDED_HEADERS = ["accept", "accept-language", "user-agent", "x-correlation-id", "x-wallet-address"];

function statusClass(status) {
  return `${Math.floor(status / 100)}xx`;
}

export function createTrafficShadowMiddleware({
  targetUrl = process.env.SHADOW_TARGET_URL,
  sampleRate = parseFloat(process.env.SHADOW_SAMPLE_RATE ?? "1"),
  timeoutMs = parseInt(process.env.SHADOW_TIMEOUT_MS ?? "5000", 10),
  fetchImpl = globalThis.fetch,
  random = Math.random,
} = {}) {
  if (!targetUrl) {
    return (_req, _res, next) => next();
  }
  const base = new URL(targetUrl);
  const rate = Number.isFinite(sampleRate) ? Math.min(Math.max(sampleRate, 0), 1) : 1;

  return function trafficShadow(req, res, next) {
    const eligible =
      SHADOWABLE_METHODS.has(req.method) &&
      !req.headers[SHADOW_HEADER] && // never re-mirror a mirrored request
      !EXCLUDED_PATH.test(req.path) &&
      random() < rate;
    if (!eligible) return next();

    res.on("finish", () => {
      const headers = { [SHADOW_HEADER]: "1" };
      for (const name of FORWARDED_HEADERS) {
        if (req.headers[name]) headers[name] = req.headers[name];
      }
      const started = Date.now();
      const primaryStatus = res.statusCode;

      Promise.resolve()
        .then(() =>
          fetchImpl(new URL(req.originalUrl, base), {
            method: req.method,
            headers,
            signal: AbortSignal.timeout(timeoutMs),
          }),
        )
        .then(async (shadowRes) => {
          // Drain the body so the connection is reused.
          await shadowRes.arrayBuffer().catch(() => {});
          const match = statusClass(shadowRes.status) === statusClass(primaryStatus);
          recordShadowRequest(match ? "match" : "mismatch", Date.now() - started);
        })
        .catch(() => recordShadowRequest("error", Date.now() - started));
    });
    next();
  };
}
