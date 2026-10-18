/**
 * Application-layer event store facade (#1066).
 *
 * This module sits between the domain (commands/projections) and the DB layer
 * (database/event-store.js). It owns:
 *
 *  - appendEvent  : validate + persist a domain event, emit to in-process subscribers
 *  - subscribe    : register a projection/read-model to be notified on new events
 *  - replayEvents : rebuild state by replaying events up to an optional point in time
 *                   (time-travel debugging)
 *
 * The DB layer (database/event-store.js) handles raw SQL.
 * This layer adds:
 *  - In-process pub/sub (Map of eventType → Set of handlers)
 *  - Time-travel: replayEvents(aggregateType, aggregateId, { asOf })
 *  - Structured logging on every append
 */

import {
  appendEvent as dbAppend,
  getAggregateEvents,
  getContractEvents,
  countContractEvents,
  getEventById,
  getAggregateVersion,
  EventTypes,
  AggregateTypes,
} from "../database/event-store.js";
import logger from "../logger.js";

// ── In-process pub/sub ────────────────────────────────────────────────────────

/** @type {Map<string, Set<Function>>} */
const subscribers = new Map();

/**
 * Subscribe to a specific event type (or "*" for all).
 * Returns an unsubscribe function.
 *
 * @param {string} eventType  - EventTypes constant or "*"
 * @param {Function} handler  - async (event) => void
 * @returns {() => void}
 */
export function subscribe(eventType, handler) {
  if (!subscribers.has(eventType)) subscribers.set(eventType, new Set());
  subscribers.get(eventType).add(handler);
  return () => subscribers.get(eventType)?.delete(handler);
}

async function emit(event) {
  const handlers = [
    ...(subscribers.get(event.eventType) ?? []),
    ...(subscribers.get("*") ?? []),
  ];
  for (const h of handlers) {
    try {
      await h(event);
    } catch (err) {
      logger.warn("Event subscriber threw", { eventType: event.eventType, error: err?.message });
    }
  }
}

// ── Append ─────────────────────────────────────────────────────────────────────

/**
 * Append a domain event, persist it, and notify subscribers.
 *
 * @param {object} params  - same shape as database/event-store.js#appendEvent
 * @returns {Promise<{ eventId: string, version: number }>}
 */
export async function appendEvent(params) {
  const result = dbAppend(params);

  logger.info("domain event appended", {
    event: "event_store_append",
    eventId: result.eventId,
    eventType: params.eventType,
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    version: result.version,
  });

  // Read back the full event so subscribers get the persisted shape
  const persisted = getEventById(result.eventId);
  if (persisted) await emit(persisted);

  return result;
}

// ── Time-travel / replay ───────────────────────────────────────────────────────

/**
 * Replay all events for an aggregate, optionally stopping at a past point in
 * time.  Passes each event through the provided reducer to rebuild state.
 *
 * Usage:
 *   const state = await replayEvents("contract", contractId, reducer, {}, { asOf: "2025-01-15T10:00:00Z" });
 *
 * @param {string}   aggregateType
 * @param {string}   aggregateId
 * @param {Function} reducer        - (state, event) => newState
 * @param {any}      initialState
 * @param {object}   [opts]
 * @param {string}   [opts.asOf]    - ISO datetime; only replay events <= this time
 * @returns {Promise<{ state: any, eventCount: number, lastEventId: string|null, asOf: string|null }>}
 */
export async function replayEvents(aggregateType, aggregateId, reducer, initialState, opts = {}) {
  const events = getAggregateEvents(aggregateType, aggregateId, {
    toOccurredAt: opts.asOf ?? undefined,
  });

  let state = initialState;
  let lastEventId = null;

  for (const event of events) {
    state = reducer(state, event);
    lastEventId = event.eventId;
  }

  logger.info("event replay completed", {
    aggregateType,
    aggregateId,
    eventCount: events.length,
    asOf: opts.asOf ?? null,
  });

  return {
    state,
    eventCount: events.length,
    lastEventId,
    asOf: opts.asOf ?? null,
  };
}

// Re-export DB-layer reads so callers import only from this module
export {
  getAggregateEvents,
  getContractEvents,
  countContractEvents,
  getEventById,
  getAggregateVersion,
  EventTypes,
  AggregateTypes,
};
