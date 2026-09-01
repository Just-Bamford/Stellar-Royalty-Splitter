/**
 * Request Complexity Budgeting Module (#892)
 *
 * Evaluates incoming request payload complexity (field count, array elements,
 * object nesting depth, nested structures, and string volume) using a deterministic,
 * iterative scoring algorithm with early-termination support.
 */

import logger from "./logger.js";
import { sendError } from "./error-response.js";

export const DEFAULT_COMPLEXITY_LIMIT = 1000;
export const FIELD_WEIGHT = 1;
export const ARRAY_ELEMENT_WEIGHT = 1;
export const STRUCTURE_WEIGHT = 2;
export const DEPTH_WEIGHT_MULTIPLIER = 3;
export const STRING_CHUNK_SIZE = 256;
export const DEFAULT_COMPLEXITY_METHODS = ["POST", "PUT", "PATCH"];

/**
 * Reads the configured complexity limit from the environment or falls back to default.
 * @returns {number}
 */
export function getComplexityLimit() {
  const envVal = parseInt(process.env.REQUEST_COMPLEXITY_LIMIT, 10);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_COMPLEXITY_LIMIT;
}

/**
 * Calculates a deterministic complexity score for an arbitrary value/object.
 * Uses an explicit iterative stack (DFS) to prevent call-stack overflow on deeply
 * nested payloads, and immediately aborts traversal once earlyExitLimit is exceeded.
 *
 * Scoring Formula:
 * - Base payload score: +1
 * - Object key / field: +1 point per key
 * - Array element: +1 point per element
 * - Structure overhead: +2 points per object or array
 * - Nesting depth: +(depth * 3) points per nesting level
 * - String volume: +Math.floor(length / 256) points for large strings
 *
 * @param {any} value - The input value to score (e.g. req.body).
 * @param {object} [options]
 * @param {number} [options.earlyExitLimit=Infinity] - Abort traversal when total score exceeds this value.
 * @returns {number} The calculated complexity score.
 */
export function calculateComplexity(value, { earlyExitLimit = Infinity } = {}) {
  if (value === null || value === undefined) {
    return 1;
  }

  const valueType = typeof value;
  if (valueType !== "object") {
    if (valueType === "string") {
      return 1 + Math.floor(value.length / STRING_CHUNK_SIZE);
    }
    return 1;
  }

  let totalScore = 1; // Base payload score
  const stack = [{ node: value, depth: 1 }];
  const seen = new WeakSet();

  while (stack.length > 0) {
    const { node, depth } = stack.pop();

    if (node === null || typeof node !== "object") {
      if (typeof node === "string") {
        totalScore += Math.floor(node.length / STRING_CHUNK_SIZE);
      }
      if (totalScore > earlyExitLimit) {
        return totalScore;
      }
      continue;
    }

    // Circular reference protection
    if (seen.has(node)) {
      continue;
    }
    seen.add(node);

    // Add structure cost and depth penalty
    totalScore += STRUCTURE_WEIGHT + depth * DEPTH_WEIGHT_MULTIPLIER;
    if (totalScore > earlyExitLimit) {
      return totalScore;
    }

    if (Array.isArray(node)) {
      const len = node.length;
      totalScore += len * ARRAY_ELEMENT_WEIGHT;
      if (totalScore > earlyExitLimit) {
        return totalScore;
      }

      for (let i = len - 1; i >= 0; i--) {
        const item = node[i];
        if (item !== null && typeof item === "object") {
          stack.push({ node: item, depth: depth + 1 });
        } else if (typeof item === "string") {
          totalScore += Math.floor(item.length / STRING_CHUNK_SIZE);
          if (totalScore > earlyExitLimit) {
            return totalScore;
          }
        }
      }
    } else {
      const keys = Object.keys(node);
      const keyCount = keys.length;
      totalScore += keyCount * FIELD_WEIGHT;
      if (totalScore > earlyExitLimit) {
        return totalScore;
      }

      for (let i = keyCount - 1; i >= 0; i--) {
        const key = keys[i];
        const val = node[key];
        if (val !== null && typeof val === "object") {
          stack.push({ node: val, depth: depth + 1 });
        } else if (typeof val === "string") {
          totalScore += Math.floor(val.length / STRING_CHUNK_SIZE);
          if (totalScore > earlyExitLimit) {
            return totalScore;
          }
        }
      }
    }
  }

  return totalScore;
}

/**
 * Express middleware that enforces request complexity budgets.
 * Evaluates parsed JSON bodies and rejects complex payloads with HTTP 400
 * before costly schema validation or cryptographic processing occurs.
 *
 * @param {object} [options]
 * @param {number} [options.limit] - Override limit (defaults to env or 1000).
 * @returns {import("express").RequestHandler}
 */
export function requestComplexityMiddleware(options = {}) {
  const methods = (options.methods ?? DEFAULT_COMPLEXITY_METHODS).map((method) =>
    String(method).toUpperCase()
  );
  const methodSet = new Set(methods);

  return (req, res, next) => {
    if (!methodSet.has(req.method)) {
      req.complexityScore = 1;
      return next();
    }

    // Only inspect requests with populated bodies
    if (!req.body || typeof req.body !== "object" || Object.keys(req.body).length === 0) {
      req.complexityScore = 1;
      return next();
    }

    const limit = options.limit ?? getComplexityLimit();
    const score = calculateComplexity(req.body, { earlyExitLimit: limit });
    req.complexityScore = score;

    if (score > limit) {
      logger.warn("Request complexity limit exceeded", {
        ip: req.ip,
        path: req.originalUrl,
        method: req.method,
        score,
        limit,
      });

      const message = `Request exceeds maximum complexity limit of ${limit} (calculated score: ${score})`;
      return sendError(res, 400, "request_too_complex", message, {
        complexity_score: score,
        limit,
      });
    }

    next();
  };
}
