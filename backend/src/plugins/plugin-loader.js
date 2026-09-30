/**
 * Plugin Loader (#998)
 *
 * Discovers and loads plugin modules from the `backend/plugins/` directory,
 * hot-reloads them via `fs.watch` when files change, and delegates all
 * registration/lifecycle work to the plugin framework.
 *
 * Plugin files must:
 *   - Live at  backend/plugins/<name>.js  (flat — no subdirectory scanning)
 *   - Use ES module syntax (`export default { name, version, description, hooks }`)
 *   - Export a default object conforming to the plugin shape
 *
 * Hot-reload behaviour:
 *   - On file change/rename: the module is re-imported (cache-busted via a
 *     `?t=<timestamp>` query param) and re-registered in the framework.
 *   - On file deletion: the plugin is unregistered from the framework.
 *   - Errors during hot-reload are caught and logged; the old plugin version
 *     keeps running.
 *   - The fs.watch listener is deliberately unref()'d so it cannot prevent
 *     clean process shutdown.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import logger from "../logger.js";
import { registerPlugin, unregisterPlugin } from "./plugin-framework.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Absolute path to the user-facing plugins directory:  backend/plugins/
const PLUGINS_DIR = path.resolve(__dirname, "..", "..", "plugins");

// ---------------------------------------------------------------------------
// Module-level watcher handle (for cleanup in tests)
// ---------------------------------------------------------------------------

let _watcher = null;

// ---------------------------------------------------------------------------
// Loader implementation
// ---------------------------------------------------------------------------

/**
 * Import a single plugin file, bypassing Node's module cache by appending a
 * timestamp query parameter. This is necessary for hot-reload to pick up
 * changes to an already-loaded file.
 *
 * @param {string} filePath  Absolute path to a .js plugin file
 * @returns {Promise<object|null>}  The plugin's default export, or null on error
 */
async function importPlugin(filePath) {
  // Append a timestamp to bust the ESM cache (import() caches by specifier)
  const specifier = `${filePath}?t=${Date.now()}`;
  const mod = await import(specifier);
  const plugin = mod.default ?? mod;
  if (!plugin || typeof plugin !== "object") {
    throw new Error(`Plugin file '${filePath}' must export a default object`);
  }
  return plugin;
}

/**
 * Load a single plugin from a file path, register it in the framework, and
 * return true on success.  Never throws — all errors are caught and logged.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function loadPluginFile(filePath) {
  try {
    const plugin = await importPlugin(filePath);
    registerPlugin(plugin, { filePath, enabled: true });
    logger.info(`[plugin-loader] Loaded plugin from '${path.basename(filePath)}'`);
    return true;
  } catch (err) {
    logger.error(`[plugin-loader] Failed to load '${path.basename(filePath)}': ${err.message}`, {
      filePath,
      error: err.message,
      stack: err.stack,
    });
    return false;
  }
}

/**
 * Scan the plugins directory and load every `.js` file found.
 * Silently succeeds (returns 0) when the directory does not exist yet.
 *
 * @returns {Promise<number>}  Number of plugins successfully loaded
 */
export async function loadAllPlugins() {
  if (!fs.existsSync(PLUGINS_DIR)) {
    logger.info(`[plugin-loader] Plugins directory not found at '${PLUGINS_DIR}'; skipping load`);
    return 0;
  }

  let entries;
  try {
    entries = fs.readdirSync(PLUGINS_DIR);
  } catch (err) {
    logger.warn(`[plugin-loader] Could not read plugins directory: ${err.message}`);
    return 0;
  }

  const jsFiles = entries.filter((f) => f.endsWith(".js") && !f.startsWith("_"));
  let loaded = 0;

  for (const filename of jsFiles) {
    const filePath = path.join(PLUGINS_DIR, filename);
    const ok = await loadPluginFile(filePath);
    if (ok) loaded++;
  }

  logger.info(`[plugin-loader] Loaded ${loaded}/${jsFiles.length} plugins from '${PLUGINS_DIR}'`);
  return loaded;
}

/**
 * Start watching the plugins directory for changes (hot-reload).
 * Debounces rapid successive change events to avoid double-loading.
 * Safe to call multiple times — will not start a second watcher.
 *
 * @returns {{ stop: () => void }}  Handle to stop the watcher
 */
export function startHotReload() {
  if (_watcher) {
    logger.info("[plugin-loader] Hot-reload watcher already running");
    return { stop: stopHotReload };
  }

  if (!fs.existsSync(PLUGINS_DIR)) {
    logger.info(`[plugin-loader] Plugins directory '${PLUGINS_DIR}' does not exist; hot-reload not started`);
    return { stop: stopHotReload };
  }

  const debounceTimers = new Map(); // filename → timer

  try {
    _watcher = fs.watch(PLUGINS_DIR, { persistent: false }, (eventType, filename) => {
      if (!filename || !filename.endsWith(".js") || filename.startsWith("_")) return;

      // Debounce: coalesce multiple events within 200ms into one reload
      if (debounceTimers.has(filename)) {
        clearTimeout(debounceTimers.get(filename));
      }

      const timer = setTimeout(async () => {
        debounceTimers.delete(filename);
        const filePath = path.join(PLUGINS_DIR, filename);

        if (!fs.existsSync(filePath)) {
          // File deleted — unregister any plugin that was loaded from it
          const pluginName = filename.replace(/\.js$/, "");
          const removed = unregisterPlugin(pluginName);
          if (removed) {
            logger.info(`[plugin-loader] Hot-unloaded plugin '${pluginName}' (file deleted)`);
          }
          return;
        }

        logger.info(`[plugin-loader] Hot-reloading '${filename}' (${eventType})`);
        await loadPluginFile(filePath);
      }, 200);

      // Unref the debounce timer — don't prevent process exit
      timer.unref?.();
      debounceTimers.set(filename, timer);
    });

    // Unref the watcher — don't prevent process exit
    _watcher.unref?.();

    logger.info(`[plugin-loader] Hot-reload watching '${PLUGINS_DIR}'`);
  } catch (err) {
    logger.warn(`[plugin-loader] Could not start hot-reload watcher: ${err.message}`);
  }

  return { stop: stopHotReload };
}

/**
 * Stop the hot-reload watcher (if running).
 */
export function stopHotReload() {
  if (_watcher) {
    try {
      _watcher.close();
    } catch (_) {
      /* ignore */
    }
    _watcher = null;
    logger.info("[plugin-loader] Hot-reload watcher stopped");
  }
}

/**
 * Return the absolute path to the plugins directory.
 * Exported for use in tests and management routes.
 */
export { PLUGINS_DIR };
