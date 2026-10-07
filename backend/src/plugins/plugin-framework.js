/**
 * Plugin Framework (#998)
 *
 * Provides the core hook registry, plugin lifecycle management, execution
 * engine, and audit/log store for the SRS plugin system.
 *
 * Design principles:
 *  - Plugin errors NEVER crash the system (all hooks are fail-open).
 *  - Every execution is logged with timing and outcome for auditability.
 *  - Plugins can be enabled/disabled at runtime without restart.
 *  - The framework has zero external dependencies beyond Node.js builtins.
 *
 * Supported hook names:
 *   beforeDistribute  – called before a distribution XDR is built.
 *                       Receives { contractId, walletAddress, tokenId }.
 *                       May return a modifier object (currently informational).
 *   afterDistribute   – called after a distribution succeeds.
 *                       Receives { contractId, walletAddress, transactionId, xdr }.
 *   onDispute         – called when a new dispute is created.
 *                       Receives the full dispute object.
 *   onPayment         – called when a payment/distribution request is initiated.
 *                       Receives { contractId, walletAddress, tokenId }.
 *
 * Plugin shape (what a plugin module must export):
 *   {
 *     name:        string          – unique identifier (kebab-case recommended)
 *     version:     string          – semver string e.g. "1.0.0"
 *     description: string          – short human-readable description
 *     hooks: {
 *       beforeDistribute?:  async (ctx) => void | object
 *       afterDistribute?:   async (ctx) => void
 *       onDispute?:         async (ctx) => void
 *       onPayment?:         async (ctx) => void
 *     }
 *   }
 */

import logger from "../logger.js";

// ---------------------------------------------------------------------------
// Types / constants
// ---------------------------------------------------------------------------

export const VALID_HOOKS = ["beforeDistribute", "afterDistribute", "onDispute", "onPayment"];

const MAX_EXECUTION_LOG_SIZE = 1000; // keep last N entries per plugin
const DEFAULT_HOOK_TIMEOUT_MS = 5000; // plugins must complete within 5 s

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

/**
 * Registry of registered plugins.
 * Map<pluginName, { plugin, enabled, registeredAt, filePath }>
 */
const registry = new Map();

/**
 * Per-plugin execution logs (ring buffer).
 * Map<pluginName, Array<logEntry>>
 */
const executionLogs = new Map();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Append an entry to a plugin's execution log, capping at MAX_EXECUTION_LOG_SIZE.
 * @param {string} pluginName
 * @param {object} entry
 */
function appendLog(pluginName, entry) {
  if (!executionLogs.has(pluginName)) {
    executionLogs.set(pluginName, []);
  }
  const log = executionLogs.get(pluginName);
  log.push(entry);
  // Keep log bounded
  if (log.length > MAX_EXECUTION_LOG_SIZE) {
    log.splice(0, log.length - MAX_EXECUTION_LOG_SIZE);
  }
}

/**
 * Validate a plugin's shape before registration.
 * Throws with a descriptive message on any validation failure.
 * @param {object} plugin
 */
function validatePlugin(plugin) {
  if (!plugin || typeof plugin !== "object") {
    throw new Error("Plugin must be a non-null object");
  }
  if (typeof plugin.name !== "string" || !plugin.name.trim()) {
    throw new Error("Plugin must have a non-empty string 'name'");
  }
  if (typeof plugin.version !== "string" || !plugin.version.trim()) {
    throw new Error(`Plugin '${plugin.name}' must have a non-empty string 'version'`);
  }
  if (!plugin.hooks || typeof plugin.hooks !== "object") {
    throw new Error(`Plugin '${plugin.name}' must have a 'hooks' object`);
  }
  for (const hookName of Object.keys(plugin.hooks)) {
    if (!VALID_HOOKS.includes(hookName)) {
      throw new Error(
        `Plugin '${plugin.name}' declares unknown hook '${hookName}'. Valid hooks: ${VALID_HOOKS.join(", ")}`
      );
    }
    if (typeof plugin.hooks[hookName] !== "function") {
      throw new Error(
        `Plugin '${plugin.name}' hook '${hookName}' must be a function`
      );
    }
  }
}

/**
 * Execute a single plugin's hook with a timeout guard.
 * Returns { result, durationMs } on success, or throws on timeout/error.
 *
 * @param {Function} hookFn
 * @param {object}   ctx
 * @param {number}   timeoutMs
 */
async function executeWithTimeout(hookFn, ctx, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Hook timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  try {
    const start = Date.now();
    const result = await Promise.race([hookFn(ctx), timeoutPromise]);
    const durationMs = Date.now() - start;
    return { result, durationMs };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a plugin.
 * Idempotent — re-registering an existing plugin replaces it.
 *
 * @param {object} plugin  Must conform to the plugin shape documented above.
 * @param {{ filePath?: string, enabled?: boolean }} [opts]
 */
export function registerPlugin(plugin, { filePath = null, enabled = true } = {}) {
  validatePlugin(plugin);

  const existing = registry.get(plugin.name);
  if (existing) {
    logger.info(`[plugins] Re-registering plugin '${plugin.name}' v${plugin.version}`);
  } else {
    logger.info(`[plugins] Registering plugin '${plugin.name}' v${plugin.version}`);
  }

  registry.set(plugin.name, {
    plugin,
    enabled,
    registeredAt: new Date().toISOString(),
    filePath,
  });

  if (!executionLogs.has(plugin.name)) {
    executionLogs.set(plugin.name, []);
  }
}

/**
 * Unregister a plugin by name.
 * @param {string} name
 * @returns {boolean} true if the plugin was found and removed
 */
export function unregisterPlugin(name) {
  const existed = registry.has(name);
  registry.delete(name);
  logger.info(`[plugins] Unregistered plugin '${name}'`);
  return existed;
}

/**
 * Enable or disable a registered plugin.
 * @param {string}  name
 * @param {boolean} enabled
 * @returns {boolean} true if the plugin was found
 */
export function setPluginEnabled(name, enabled) {
  const entry = registry.get(name);
  if (!entry) return false;
  entry.enabled = enabled;
  logger.info(`[plugins] Plugin '${name}' ${enabled ? "enabled" : "disabled"}`);
  return true;
}

/**
 * Run all registered, enabled plugins that implement `hookName`.
 * Errors in individual plugins are caught, logged, and do NOT propagate.
 *
 * @param {string} hookName  One of VALID_HOOKS
 * @param {object} ctx       Context object passed to the hook
 * @returns {Promise<Array<{ pluginName, success, result, durationMs, error }>>}
 */
export async function runHook(hookName, ctx) {
  if (!VALID_HOOKS.includes(hookName)) {
    logger.warn(`[plugins] Unknown hook '${hookName}' — skipping`);
    return [];
  }

  const results = [];

  for (const [name, entry] of registry.entries()) {
    if (!entry.enabled) continue;
    const hookFn = entry.plugin.hooks[hookName];
    if (typeof hookFn !== "function") continue;

    const logEntry = {
      hookName,
      pluginName: name,
      pluginVersion: entry.plugin.version,
      executedAt: new Date().toISOString(),
      contextSummary: summarizeContext(ctx),
    };

    try {
      const { result, durationMs } = await executeWithTimeout(hookFn, ctx);
      logEntry.success = true;
      logEntry.durationMs = durationMs;
      logEntry.result = result !== undefined ? String(result) : null;
      results.push({ pluginName: name, success: true, result, durationMs, error: null });
      logger.info(`[plugins] Hook '${hookName}' ran by '${name}' in ${durationMs}ms`);
    } catch (err) {
      logEntry.success = false;
      logEntry.durationMs = null;
      logEntry.error = err.message ?? String(err);
      results.push({ pluginName: name, success: false, result: null, durationMs: null, error: logEntry.error });
      // Fail-open: log the error but do NOT re-throw
      logger.error(`[plugins] Hook '${hookName}' in plugin '${name}' failed: ${err.message}`, {
        hook: hookName,
        plugin: name,
        error: err.message,
        stack: err.stack,
      });
    }

    appendLog(name, logEntry);
  }

  return results;
}

/**
 * Return a summary of all registered plugins (for management endpoints).
 * @returns {Array<object>}
 */
export function listPlugins() {
  return Array.from(registry.entries()).map(([name, entry]) => ({
    name,
    version: entry.plugin.version,
    description: entry.plugin.description ?? "",
    hooks: Object.keys(entry.plugin.hooks),
    enabled: entry.enabled,
    registeredAt: entry.registeredAt,
    filePath: entry.filePath,
  }));
}

/**
 * Return the execution log for a specific plugin (newest first).
 * @param {string}  pluginName
 * @param {number}  [limit=100]
 * @returns {Array<object>}
 */
export function getPluginLogs(pluginName, limit = 100) {
  const logs = executionLogs.get(pluginName) ?? [];
  return logs.slice(-limit).reverse();
}

/**
 * Return an aggregated audit view across all plugins (newest first).
 * @param {number} [limit=200]
 * @returns {Array<object>}
 */
export function getAuditLog(limit = 200) {
  const all = [];
  for (const logs of executionLogs.values()) {
    all.push(...logs);
  }
  all.sort((a, b) => (a.executedAt < b.executedAt ? 1 : -1));
  return all.slice(0, limit);
}

/**
 * Clear execution logs for a plugin (for testing / maintenance).
 * @param {string} [pluginName] — if omitted, clears all logs
 */
export function clearLogs(pluginName) {
  if (pluginName) {
    executionLogs.set(pluginName, []);
  } else {
    for (const key of executionLogs.keys()) {
      executionLogs.set(key, []);
    }
  }
}

/**
 * Return the count of currently registered plugins.
 * @returns {number}
 */
export function getRegistrySize() {
  return registry.size;
}

// ---------------------------------------------------------------------------
// Internal utility
// ---------------------------------------------------------------------------

/**
 * Produce a lightweight, non-sensitive summary of a hook context for logging.
 * Redacts anything that looks like a private key or secret.
 * @param {object} ctx
 * @returns {object}
 */
function summarizeContext(ctx) {
  if (!ctx || typeof ctx !== "object") return {};
  const summary = {};
  const REDACT_KEYS = /secret|key|password|token|auth|xdr/i;
  for (const [k, v] of Object.entries(ctx)) {
    if (REDACT_KEYS.test(k)) {
      summary[k] = "[redacted]";
    } else if (typeof v === "string" && v.length > 80) {
      summary[k] = v.slice(0, 80) + "…";
    } else {
      summary[k] = v;
    }
  }
  return summary;
}
