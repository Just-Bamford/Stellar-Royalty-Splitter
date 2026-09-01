// Structured logger (#278).
//
// Winston-backed JSON logger with env-driven log level. Levels:
// error < warn < info < debug. Production deployments typically run
// at `info`; bumping to `debug` in dev surfaces request/response
// shapes without code changes.
//
// Invalid `LOG_LEVEL` values fall back to `info` (and log a warning
// once on boot) so a typo can't silence the whole app.

import winston from "winston";
import TransportStream from "winston-transport";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendApplicationLog } from "./database/application-logs.js";

export const asyncLocalStorage = new AsyncLocalStorage();

const VALID_LEVELS = ["error", "warn", "info", "debug"];
const DEFAULT_LEVEL = "info";

export function resolveLevel(rawLevel = process.env.LOG_LEVEL) {
  if (!rawLevel) return DEFAULT_LEVEL;
  const lc = String(rawLevel).toLowerCase();
  if (VALID_LEVELS.includes(lc)) return lc;
  return DEFAULT_LEVEL;
}

const resolvedLevel = resolveLevel();

const correlationIdFormat = winston.format((info) => {
  const store = asyncLocalStorage.getStore();
  if (store && store.correlationId) {
    info.correlationId = store.correlationId;
  }
  return info;
});

class CentralizedLogTransport extends TransportStream {
  log(info, callback) {
    setImmediate(() => this.emit("logged", info));
    const { level, message, correlationId, requestId, timestamp, ...metadata } = info;
    appendApplicationLog({
      level,
      message,
      correlationId: correlationId ?? null,
      requestId: requestId ?? null,
      service: process.env.LOG_SERVICE_NAME ?? "api",
      metadata: { ...metadata, timestamp },
    });
    callback();
  }
}

const logger = winston.createLogger({
  level: resolvedLevel,
  format: winston.format.combine(
    correlationIdFormat(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console(), new CentralizedLogTransport()],
});

// Surface invalid LOG_LEVEL once on boot so misconfig is visible.
if (
  process.env.LOG_LEVEL &&
  resolvedLevel !== String(process.env.LOG_LEVEL).toLowerCase()
) {
  logger.warn(
    `Invalid LOG_LEVEL '${process.env.LOG_LEVEL}' — falling back to '${DEFAULT_LEVEL}'. Valid values: ${VALID_LEVELS.join(", ")}.`,
  );
}

export { VALID_LEVELS };

export default logger;
