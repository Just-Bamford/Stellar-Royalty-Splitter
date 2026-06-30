import { sendError } from "./error-response.js";

const LEGACY_API_PREFIX = "/api";

export const LEGACY_API_ALLOWED_ROOT_SEGMENTS = new Set([
  "analytics",
  "audit",
  "collaborators",
  "contract",
  "distribute",
  "health",
  "history",
  "initialize",
  "metrics",
  "secondary-royalty",
  "simulate",
  "transaction",
  "webhooks",
]);

function buildRequestUrl(requestTarget) {
  const normalizedRequestTarget = requestTarget.startsWith("/")
    ? requestTarget
    : `/${requestTarget}`;
  const parsedUrl = new URL(normalizedRequestTarget, "http://legacy-api.local");
  const rawPath = normalizedRequestTarget.slice(
    0,
    normalizedRequestTarget.length - parsedUrl.search.length
  );

  return {
    parsedUrl,
    rawPath,
  };
}

function collectDecodedPathVariants(rawPath, maxPasses = 3) {
  const variants = [];
  let current = rawPath;

  for (let index = 0; index < maxPasses; index += 1) {
    variants.push(current);

    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) {
        return { malformedEncoding: false, variants };
      }
      current = decoded;
    } catch {
      return { malformedEncoding: true, variants };
    }
  }

  variants.push(current);
  return { malformedEncoding: false, variants };
}

function containsTraversalSegment(pathname) {
  return pathname
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment === "..");
}

function getLegacyRootSegment(normalizedPathname) {
  if (normalizedPathname === LEGACY_API_PREFIX) {
    return "";
  }

  if (!normalizedPathname.startsWith(`${LEGACY_API_PREFIX}/`)) {
    return null;
  }

  return normalizedPathname.slice(LEGACY_API_PREFIX.length + 1).split("/")[0] ?? "";
}

export function validateLegacyApiRequestTarget(requestTarget) {
  const { parsedUrl, rawPath } = buildRequestUrl(requestTarget);
  const { malformedEncoding, variants } = collectDecodedPathVariants(rawPath);

  if (malformedEncoding) {
    return {
      allowed: false,
      normalizedPathname: parsedUrl.pathname,
      reason: "malformed_encoding",
    };
  }

  if (variants.some(containsTraversalSegment)) {
    return {
      allowed: false,
      normalizedPathname: parsedUrl.pathname,
      reason: "path_traversal",
    };
  }

  const rootSegment = getLegacyRootSegment(parsedUrl.pathname);

  if (rootSegment == null) {
    return {
      allowed: false,
      normalizedPathname: parsedUrl.pathname,
      reason: "invalid_prefix",
    };
  }

  if (rootSegment !== "" && !LEGACY_API_ALLOWED_ROOT_SEGMENTS.has(rootSegment)) {
    return {
      allowed: false,
      normalizedPathname: parsedUrl.pathname,
      reason: "disallowed_path",
      rootSegment,
    };
  }

  const redirectPath =
    parsedUrl.pathname === LEGACY_API_PREFIX
      ? "/api/v1"
      : `/api/v1${parsedUrl.pathname.slice(LEGACY_API_PREFIX.length)}`;

  return {
    allowed: true,
    normalizedPathname: parsedUrl.pathname,
    redirectTarget: `${redirectPath}${parsedUrl.search}`,
    rootSegment,
  };
}

export function createLegacyApiRedirectMiddleware({ logger } = {}) {
  return (req, res, next) => {
    if (req.originalUrl === "/api/v1" || req.originalUrl.startsWith("/api/v1/")) {
      return next();
    }

    if (
      req.originalUrl !== LEGACY_API_PREFIX &&
      !req.originalUrl.startsWith(`${LEGACY_API_PREFIX}/`)
    ) {
      return next();
    }

    const validation = validateLegacyApiRequestTarget(req.originalUrl);

    if (!validation.allowed) {
      logger?.warn?.("Rejected legacy API redirect target", {
        correlationId: req.correlationId,
        ip: req.ip,
        method: req.method,
        normalizedPathname: validation.normalizedPathname,
        path: req.originalUrl,
        reason: validation.reason,
      });

      return sendError(res, 400, "invalid_legacy_api_path", "Invalid legacy API path.");
    }

    return res.redirect(308, validation.redirectTarget);
  };
}
