/**
 * Plugin management routes (#998).
 *
 * All endpoints require operator-or-above RBAC privilege.
 *
 * GET  /api/v1/plugins                     — list all registered plugins
 * GET  /api/v1/plugins/:name               — get a single plugin's details
 * POST /api/v1/plugins/:name/enable        — enable a plugin
 * POST /api/v1/plugins/:name/disable       — disable a plugin
 * GET  /api/v1/plugins/:name/logs          — view execution logs for a plugin
 * GET  /api/v1/plugins/audit               — cross-plugin audit log (newest first)
 * POST /api/v1/plugins/reload              — trigger a manual hot-reload of all plugins
 */

import { Router } from "express";
import { sendError } from "../error-response.js";
import { requireRole } from "../middleware/rbac.js";
import {
  listPlugins,
  setPluginEnabled,
  getPluginLogs,
  getAuditLog,
} from "../plugins/plugin-framework.js";
import { loadAllPlugins } from "../plugins/plugin-loader.js";
import logger from "../logger.js";

export const pluginsRouter = Router();

// All plugin management endpoints require at least 'operator' role.
pluginsRouter.use(requireRole("operator"));

// ---------------------------------------------------------------------------
// GET /api/v1/plugins
// List all registered plugins with their status and declared hooks.
// ---------------------------------------------------------------------------
pluginsRouter.get("/", (_req, res) => {
  const plugins = listPlugins();
  return res.json({ success: true, data: plugins, count: plugins.length });
});

// ---------------------------------------------------------------------------
// GET /api/v1/plugins/audit
// NOTE: must be defined BEFORE /:name to avoid "audit" being treated as a name.
// Returns a cross-plugin audit log (most recent first).
// Query: ?limit=<number>  (default 200, max 500)
// ---------------------------------------------------------------------------
pluginsRouter.get("/audit", (_req, res) => {
  const rawLimit = parseInt(_req.query.limit ?? "200", 10);
  const limit = Math.min(Math.max(rawLimit || 200, 1), 500);
  const entries = getAuditLog(limit);
  return res.json({ success: true, data: entries, count: entries.length });
});

// ---------------------------------------------------------------------------
// POST /api/v1/plugins/reload
// Trigger a manual re-scan of the plugins directory and reload all plugins.
// NOTE: must be defined BEFORE /:name to avoid "reload" being treated as a name.
// ---------------------------------------------------------------------------
pluginsRouter.post("/reload", async (_req, res) => {
  try {
    const loaded = await loadAllPlugins();
    logger.info(`[plugins] Manual reload triggered; ${loaded} plugin(s) loaded`);
    return res.json({
      success: true,
      message: `Plugin directory scanned. ${loaded} plugin(s) loaded.`,
      loaded,
    });
  } catch (err) {
    logger.error("[plugins] Manual reload failed", { error: err.message });
    return sendError(res, 500, "plugin_reload_failed", "Failed to reload plugins");
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/plugins/:name
// Get details for a single plugin.
// ---------------------------------------------------------------------------
pluginsRouter.get("/:name", (req, res) => {
  const { name } = req.params;
  const plugins = listPlugins();
  const plugin = plugins.find((p) => p.name === name);
  if (!plugin) {
    return sendError(res, 404, "plugin_not_found", `No plugin registered with name '${name}'`);
  }
  return res.json({ success: true, data: plugin });
});

// ---------------------------------------------------------------------------
// POST /api/v1/plugins/:name/enable
// Enable a disabled plugin.
// ---------------------------------------------------------------------------
pluginsRouter.post("/:name/enable", (req, res) => {
  const { name } = req.params;
  const found = setPluginEnabled(name, true);
  if (!found) {
    return sendError(res, 404, "plugin_not_found", `No plugin registered with name '${name}'`);
  }
  logger.info(`[plugins] Plugin '${name}' enabled via API`);
  return res.json({ success: true, message: `Plugin '${name}' enabled` });
});

// ---------------------------------------------------------------------------
// POST /api/v1/plugins/:name/disable
// Disable a plugin (it will be skipped on subsequent hook executions).
// ---------------------------------------------------------------------------
pluginsRouter.post("/:name/disable", (req, res) => {
  const { name } = req.params;
  const found = setPluginEnabled(name, false);
  if (!found) {
    return sendError(res, 404, "plugin_not_found", `No plugin registered with name '${name}'`);
  }
  logger.info(`[plugins] Plugin '${name}' disabled via API`);
  return res.json({ success: true, message: `Plugin '${name}' disabled` });
});

// ---------------------------------------------------------------------------
// GET /api/v1/plugins/:name/logs
// View recent execution logs for a specific plugin.
// Query: ?limit=<number>  (default 100, max 500)
// ---------------------------------------------------------------------------
pluginsRouter.get("/:name/logs", (req, res) => {
  const { name } = req.params;
  const plugins = listPlugins();
  const exists = plugins.some((p) => p.name === name);
  if (!exists) {
    return sendError(res, 404, "plugin_not_found", `No plugin registered with name '${name}'`);
  }

  const rawLimit = parseInt(req.query.limit ?? "100", 10);
  const limit = Math.min(Math.max(rawLimit || 100, 1), 500);
  const logs = getPluginLogs(name, limit);

  return res.json({ success: true, data: logs, count: logs.length });
});
