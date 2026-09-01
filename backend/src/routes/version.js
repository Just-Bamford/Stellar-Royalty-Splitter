import { Router } from "express";

export const versionRouter = Router();

const CURRENT_VERSION = "v1";
const SUPPORTED_VERSIONS = ["v1"];
const DEPRECATED_VERSIONS = [];

/**
 * GET /api/v1/version
 * Returns current API version, supported versions, and deprecation status.
 */
versionRouter.get("/", (_req, res) => {
  res.json({
    success: true,
    data: {
      current: CURRENT_VERSION,
      supported: SUPPORTED_VERSIONS,
      deprecated: DEPRECATED_VERSIONS,
      sunset: null,
      documentation: "/api/docs",
    },
  });
});
