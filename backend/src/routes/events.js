/**
 * CQRS / Event-sourcing HTTP routes (#1066)
 *
 *   GET  /api/v1/events/:contractId              — paginated event log
 *   GET  /api/v1/events/:contractId/state        — current projected state
 *   GET  /api/v1/events/:contractId/state?asOf=  — time-travel: state at past time
 *   GET  /api/v1/events/:contractId/earnings     — earnings projection
 *   GET  /api/v1/events/event/:eventId            — single event by ID
 *   POST /api/v1/commands/distribute             — CQRS distribute command
 *   POST /api/v1/commands/initialize             — CQRS initialize command
 */
import { Router } from "express";
import { sendError } from "../error-response.js";
import { validateContractId, parsePagination, validate } from "../validation.js";
import { getEventById } from "../events/event-store.js";
import { queryContractHistory } from "../queries/contract-history-query.js";
import { queryStateAtTime } from "../queries/time-travel-query.js";
import { projectEarningsSummary } from "../projections/earnings-projection.js";
import { projectContractState } from "../projections/contract-state-projection.js";
import { handleDistributeCommand } from "../commands/distribute-command.js";
import { handleInitializeCommand } from "../commands/initialize-command.js";
import { distributeSchema, initializeSchema } from "../validation.js";
import { deduplicationMiddleware, idempotencyMiddleware } from "../idempotency.js";
import { tieredLimiters } from "../middleware/tieredRateLimit.js";

export const eventsRouter = Router();
export const commandsRouter = Router();

// An ISO 8601 date or date-time: YYYY-MM-DD, optionally followed by a time.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Validate the optional `asOf` query parameter (#1372).
 *
 * Returns true when `asOf` is absent or a valid ISO date string. Otherwise it
 * sends a 400 and returns false, so a bad value never reaches the projection
 * layer where it would surface as a 500.
 */
function validateAsOf(asOf, res) {
  if (asOf === undefined || asOf === "") return true;
  if (
    typeof asOf !== "string" ||
    !ISO_DATE_PATTERN.test(asOf) ||
    Number.isNaN(new Date(asOf).getTime())
  ) {
    sendError(res, 400, "invalid_query_parameter", "asOf must be a valid ISO date string");
    return false;
  }
  return true;
}

// ── Event store queries ────────────────────────────────────────────────────────

// GET /api/v1/events/:contractId
eventsRouter.get("/:contractId", (req, res) => {
  if (!validateContractId(req.params.contractId, res)) return;
  const { contractId } = req.params;

  const pagination = parsePagination(req.query, res, 50, 200);
  if (!pagination) return;

  const { eventType, from, to } = req.query;
  const result = queryContractHistory(contractId, {
    eventType: eventType ?? undefined,
    fromOccurredAt: from ?? undefined,
    toOccurredAt: to ?? undefined,
    limit: pagination.limit,
    offset: pagination.offset,
  });

  res.json(result);
});

// GET /api/v1/events/:contractId/state[?asOf=ISO]
eventsRouter.get("/:contractId/state", async (req, res, next) => {
  if (!validateContractId(req.params.contractId, res)) return;
  const { contractId } = req.params;
  const { asOf } = req.query;
  if (!validateAsOf(asOf, res)) return;

  try {
    const result = asOf
      ? await queryStateAtTime(contractId, asOf)
      : await projectContractState(contractId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/events/:contractId/earnings[?asOf=ISO]
eventsRouter.get("/:contractId/earnings", (req, res) => {
  if (!validateContractId(req.params.contractId, res)) return;
  const { asOf } = req.query;
  if (!validateAsOf(asOf, res)) return;
  const result = projectEarningsSummary(req.params.contractId, { asOf });
  res.json(result);
});

// GET /api/v1/events/event/:eventId
eventsRouter.get("/event/:eventId", (req, res) => {
  const event = getEventById(req.params.eventId);
  if (!event) return sendError(res, 404, "not_found", "Event not found");
  res.json({ event });
});

// ── CQRS Commands ──────────────────────────────────────────────────────────────

// POST /api/v1/commands/distribute
commandsRouter.post(
  "/distribute",
  ...tieredLimiters,
  deduplicationMiddleware("distribute"),
  idempotencyMiddleware,
  validate(distributeSchema),
  async (req, res, next) => {
    try {
      const { contractId, walletAddress, tokenId } = req.body;
      const result = await handleDistributeCommand({
        contractId,
        walletAddress,
        tokenId,
        metadata: { correlationId: req.correlationId },
      });
      res.json(result);
    } catch (err) {
      if (err.status) return sendError(res, err.status, err.code, err.message);
      next(err);
    }
  }
);

// POST /api/v1/commands/initialize
commandsRouter.post(
  "/initialize",
  ...tieredLimiters,
  validate(initializeSchema),
  async (req, res, next) => {
    try {
      const { contractId, walletAddress, collaborators, shares } = req.body;
      const result = await handleInitializeCommand({
        contractId,
        walletAddress,
        collaborators,
        shares,
        metadata: { correlationId: req.correlationId },
      });
      res.json(result);
    } catch (err) {
      if (err.status) return sendError(res, err.status, err.code, err.message);
      next(err);
    }
  }
);
