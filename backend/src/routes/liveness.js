/**
 * Liveness and readiness probes — closes #660
 *
 * GET /health
 *   Confirms the API process is running. Deliberately does nothing but
 *   read in-memory state so it stays cheap enough for frequent polling by
 *   deployment platforms / uptime monitors.
 *
 * GET /ready
 *   Confirms the dependencies the API actually needs to serve traffic
 *   (the local database and Stellar Horizon) are reachable. Returns 503
 *   when a dependency is down so orchestrators can hold traffic until the
 *   service recovers.
 *
 * Neither endpoint exposes API keys, environment variables, or other
 * internal configuration — only booleans/labels.
 */

import { Router } from "express";
import { getMigrationVersion } from "../database/index.js";
import { getNetworkLabel, checkHorizonConnectivity } from "../stellar.js";
import logger from "../logger.js";

export const livenessRouter = Router();

livenessRouter.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    network: getNetworkLabel(),
    uptime: process.uptime(),
  });
});

livenessRouter.get("/ready", async (_req, res) => {
  const dependencies = { database: false, horizon: false };

  try {
    // Cheap query against the migrations table — confirms the DB file is
    // open and readable without touching application tables.
    getMigrationVersion();
    dependencies.database = true;
  } catch (err) {
    logger.warn("Readiness check: database unavailable", { error: err.message });
  }

  try {
    const horizon = await checkHorizonConnectivity();
    dependencies.horizon = horizon.connected;
  } catch (err) {
    logger.warn("Readiness check: Horizon unavailable", { error: err.message });
  }

  const ready = dependencies.database && dependencies.horizon;
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    dependencies,
  });
});
