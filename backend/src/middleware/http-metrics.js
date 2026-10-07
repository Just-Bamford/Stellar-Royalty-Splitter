import { recordHttpRequest } from "../metrics.js";

/**
 * Feed `http_requests_total` / `http_request_duration_seconds`.
 *
 * These series back the request-latency heatmap and p50/p95/p99 panels (#935),
 * the latency and error-rate alerts, and canary analysis (#936), but nothing
 * was recording them. The route label is the matched Express pattern
 * (`/api/v1/history/:contractId`), never the raw URL, so ids in paths cannot
 * explode the series count; requests that matched no route are "unmatched".
 */
export function routeLabel(req) {
  if (req.route?.path !== undefined) {
    const routePath = Array.isArray(req.route.path) ? req.route.path[0] : String(req.route.path);
    return `${req.baseUrl ?? ""}${routePath === "/" && req.baseUrl ? "" : routePath}` || "/";
  }
  return "unmatched";
}

export function httpMetricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    recordHttpRequest(req.method, routeLabel(req), res.statusCode, durationMs);
  });
  next();
}
