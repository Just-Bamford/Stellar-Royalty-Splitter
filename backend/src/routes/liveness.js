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

/**
 * Upper bound on how long /ready waits for Horizon. Orchestrator readiness
 * probes typically time out after 2-5 seconds, so this must stay below that
 * or a hung Horizon turns into a hung probe instead of a clean 503.
 */
export const READINESS_HORIZON_TIMEOUT_MS = 3000;

/**
 * Reject if `promise` has not settled within `ms`. The timer is cleared as
 * soon as the promise settles so no stray timers are left behind.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
    const horizon = await withTimeout(
      checkHorizonConnectivity(),
      READINESS_HORIZON_TIMEOUT_MS,
      "Horizon connectivity check",
    );
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
