/**
 * Event search and filtering endpoints.
 * Provides API for querying indexed contract events with advanced filtering.
 */

import { Router } from "express";
import { validateContractIdMiddleware, parsePagination } from "../validation.js";
import { sendError } from "../error-response.js";

const router = Router();

/**
 * GET /api/v1/events/search
 * Search and filter indexed contract events.
 * Query params:
 *   - contractId: Contract address (required)
 *   - eventType: Filter by event type (optional)
 *   - startLedger: Filter events from this ledger onwards (optional)
 *   - endLedger: Filter events up to this ledger (optional)
 *   - startDate/endDate: ISO 8601 date range filter (optional)
 *   - transactionHash: Filter by transaction hash (optional)
 *   - address: Filter by address in event data (optional)
 *   - limit (default 50), offset (default 0): Pagination
 * Returns: { events, pagination }
 */
router.get("/events/search", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    const {
      eventType,
      startLedger,
      endLedger,
      startDate,
      endDate,
      transactionHash,
      address,
    } = req.query;

    const pagination = parsePagination(req.query, res);
    if (!pagination) return;
    const { limit, offset } = pagination;

    const events = searchIndexedEvents(
      contractId,
      { eventType, startLedger, endLedger, startDate, endDate, transactionHash, address },
      limit,
      offset
    );

    const total = countIndexedEvents(
      contractId,
      { eventType, startLedger, endLedger, startDate, endDate, transactionHash, address }
    );

    res.json({
      success: true,
      data: events,
      pagination: { limit, offset, total },
    });
  } catch (error) {
    logger.error("Error searching indexed events:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to search events");
  }
});

/**
 * GET /api/v1/events/stats/:contractId
 * Get event statistics for a contract.
 * Returns: { totalEvents, eventsByType, eventsByLedger }
 */
router.get("/events/stats/:contractId", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;

    const stats = getEventStats(contractId);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error("Error fetching event stats:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch event stats");
  }
});

/**
 * GET /api/v1/events/:eventId
 * Get a specific indexed event by its ID.
 * Returns: { event }
 */
router.get("/events/:eventId", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    const { eventId } = req.params;

    const event = getIndexedEventById(contractId, eventId);

    if (!event) {
      return sendError(res, 404, "not_found", "Event not found");
    }

    res.json({
      success: true,
      data: event,
    });
  } catch (error) {
    logger.error("Error fetching indexed event:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch indexed event");
  }
});

export default router;

import { searchIndexedEvents, countIndexedEvents, getEventStats, getIndexedEventById } from "./eventDatabase.js";