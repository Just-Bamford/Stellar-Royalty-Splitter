/**
 * Shared utility functions used across backend modules
 */

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms - milliseconds
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a positive integer from a value (typically from environment variables).
 * Returns the fallback if value is not a positive integer.
 * @param {string|number|undefined} value - value to parse
 * @param {number} fallback - default if parsing fails
 * @returns {number}
 */
export function parsePositiveInt(value, fallback) {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
