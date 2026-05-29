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

const VALID_LEVELS = ["error", "warn", "info", "debug"];
const DEFAULT_LEVEL = "info";

export function resolveLevel(rawLevel = process.env.LOG_LEVEL) {
  if (!rawLevel) return DEFAULT_LEVEL;
  const lc = String(rawLevel).toLowerCase();
  if (VALID_LEVELS.includes(lc)) return lc;
  return DEFAULT_LEVEL;
}

const resolvedLevel = resolveLevel();

const logger = winston.createLogger({
  level: resolvedLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console()],
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
