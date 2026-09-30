import { Router } from "express";
import {
  CURRENT_VERSION,
  DEPRECATED_VERSIONS,
  SUPPORTED_VERSIONS,
} from "../middleware/api-versioning.js";

export const versionRouter = Router();

/**
 * GET /api/version
 * Returns the current API version, all supported versions, and the
 * deprecation timeline for each legacy version.
 */
versionRouter.get("/", (_req, res) => {
  const deprecated = Object.entries(DEPRECATED_VERSIONS).map(([version, info) => ({
    version,
    deprecatedAt: info.deprecatedAt,
    sunsetAt: info.sunsetAt,
    message: info.message,
  }));

  res.json({
    success: true,
    data: {
      current: CURRENT_VERSION,
      supported: SUPPORTED_VERSIONS,
      deprecated,
      sunset: deprecated.length ? deprecated[deprecated.length - 1].sunsetAt : null,
      documentation: "/api/docs/migration-guide",
    },
  });
});
