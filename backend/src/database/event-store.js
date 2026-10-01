/**
 * Event store DB layer — append-only persistence for domain events (#1066).
 *
 * The domain_events table is the source of truth for event sourcing.
 * Every row is immutable once written — there is no UPDATE or DELETE path.
 *
 * Schema:
 *   eventId       UUID v4 — globally unique, idempotency key
 *   eventType     e.g. "DistributionInitiated", "ContractInitialized"
 *   aggregateType e.g. "contract", "collaborator"
 *   aggregateId   the natural identifier of the aggregate (e.g. contractId)
 *   contractId    denormalized for fast per-contract queries (nullable)
 *   actor         wallet address or "system" that caused the event
 *   payload       JSON — event-specific data
 *   metadata      JSON — correlation IDs, causation chain, etc.
 *   version       per-aggregate monotonic sequence (optimistic concurrency)
 *   occurredAt    wall-clock time of the event
 */

import { db, countWrite } from "./core.js";
import { randomUUID } from "crypto";

// ── Append ─────────────────────────────────────────────────────────────────────

/**
 * Append a single domain event to the store.
 * The event is written atomically and is never modified afterwards.
 *
 * @param {object} event
 * @param {string} event.eventType       - e.g. "DistributionInitiated"
 * @param {string} event.aggregateType   - e.g. "contract"
 * @param {string} event.aggregateId     - natural aggregate ID
 * @param {string|null} [event.contractId] - denormalized; set when aggregate IS a contract
 * @param {string|null} [event.actor]    - wallet address or "system"
 * @param {object} [event.payload]       - event-specific data
 * @param {object} [event.metadata]      - correlation IDs, causation, etc.
 * @param {number} [event.expectedVersion] - optimistic concurrency check; pass current
 *                                           aggregate version, throws on mismatch
 * @returns {{ eventId: string, version: number }}
 */
export function appendEvent({
  eventType,
  aggregateType,
  aggregateId,
  contractId = null,
  actor = null,
  payload = {},
  metadata = {},
  expectedVersion = null,
}) {
  if (!eventType || !aggregateType || !aggregateId) {
    throw new Error("appendEvent: eventType, aggregateType, and aggregateId are required");
  }

  const eventId = randomUUID();

  // Optimistic concurrency check
  if (expectedVersion !== null) {
    const current = db
      .prepare(
        `SELECT MAX(version) as v FROM domain_events
         WHERE aggregateType = ? AND aggregateId = ?`
      )
      .get(aggregateType, aggregateId);
    const currentVersion = current?.v ?? 0;
    if (currentVersion !== expectedVersion) {
      const err = new Error(
        `Optimistic concurrency conflict on ${aggregateType}/${aggregateId}: ` +
        `expected version ${expectedVersion} but current is ${currentVersion}`
      );
      err.code = "concurrency_conflict";
      err.status = 409;
      throw err;
    }
  }

  // Derive next version
  const versionRow = db
    .prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS nextVersion
       FROM domain_events
       WHERE aggregateType = ? AND aggregateId = ?`
    )
    .get(aggregateType, aggregateId);
  const version = versionRow.nextVersion;

  db.prepare(`
    INSERT INTO domain_events
      (eventId, eventType, aggregateType, aggregateId, contractId, actor, payload, metadata, version, occurredAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    eventId,
    eventType,
    aggregateType,
    aggregateId,
    contractId,
    actor,
    JSON.stringify(payload),
    JSON.stringify(metadata),
    version
  );
  countWrite();

  return { eventId, version };
}

// ── Read ───────────────────────────────────────────────────────────────────────

/**
 * Read all events for an aggregate in occurrence order (replay order).
 *
 * @param {string} aggregateType
 * @param {string} aggregateId
 * @param {object} [opts]
 * @param {string}  [opts.fromOccurredAt] - ISO datetime lower bound (inclusive)
 * @param {string}  [opts.toOccurredAt]   - ISO datetime upper bound (inclusive)
 * @param {number}  [opts.fromVersion]    - minimum version number (inclusive)
 * @returns {object[]} Parsed event rows
 */
export function getAggregateEvents(aggregateType, aggregateId, opts = {}) {
  let query = `
    SELECT * FROM domain_events
    WHERE aggregateType = ? AND aggregateId = ?
  `;
  const params = [aggregateType, aggregateId];

  if (opts.fromOccurredAt) {
    query += ` AND occurredAt >= ?`;
    params.push(opts.fromOccurredAt);
  }
  if (opts.toOccurredAt) {
    query += ` AND occurredAt <= ?`;
    params.push(opts.toOccurredAt);
  }
  if (opts.fromVersion != null) {
    query += ` AND version >= ?`;
    params.push(opts.fromVersion);
  }

  query += ` ORDER BY version ASC`;

  return db.prepare(query).all(...params).map(parseEventRow);
}

/**
 * Read all events for a contract (across all aggregates) in occurrence order.
 *
 * @param {string} contractId
 * @param {object} [opts]
 * @param {string}  [opts.eventType]      - filter to a specific event type
 * @param {string}  [opts.fromOccurredAt] - ISO datetime lower bound (inclusive)
 * @param {string}  [opts.toOccurredAt]   - ISO datetime upper bound (inclusive)
 * @param {number}  [opts.limit]
 * @param {number}  [opts.offset]
 * @returns {object[]}
 */
export function getContractEvents(contractId, opts = {}) {
  let query = `SELECT * FROM domain_events WHERE contractId = ?`;
  const params = [contractId];

  if (opts.eventType) {
    query += ` AND eventType = ?`;
    params.push(opts.eventType);
  }
  if (opts.fromOccurredAt) {
    query += ` AND occurredAt >= ?`;
    params.push(opts.fromOccurredAt);
  }
  if (opts.toOccurredAt) {
    query += ` AND occurredAt <= ?`;
    params.push(opts.toOccurredAt);
  }

  query += ` ORDER BY occurredAt ASC`;

  if (opts.limit != null) {
    query += ` LIMIT ?`;
    params.push(opts.limit);
  }
  if (opts.offset != null) {
    query += ` OFFSET ?`;
    params.push(opts.offset);
  }

  return db.prepare(query).all(...params).map(parseEventRow);
}

/**
 * Count events for a contract (for pagination).
 *
 * @param {string} contractId
 * @param {object} [opts]
 * @returns {number}
 */
export function countContractEvents(contractId, opts = {}) {
  let query = `SELECT COUNT(*) as total FROM domain_events WHERE contractId = ?`;
  const params = [contractId];

  if (opts.eventType) {
    query += ` AND eventType = ?`;
    params.push(opts.eventType);
  }
  if (opts.fromOccurredAt) {
    query += ` AND occurredAt >= ?`;
    params.push(opts.fromOccurredAt);
  }
  if (opts.toOccurredAt) {
    query += ` AND occurredAt <= ?`;
    params.push(opts.toOccurredAt);
  }

  return db.prepare(query).get(...params).total;
}

/**
 * Fetch a single event by its stable eventId.
 *
 * @param {string} eventId
 * @returns {object|null}
 */
export function getEventById(eventId) {
  const row = db
    .prepare(`SELECT * FROM domain_events WHERE eventId = ?`)
    .get(eventId);
  return row ? parseEventRow(row) : null;
}

/**
 * Get the current aggregate version (highest event version number).
 * Returns 0 if no events exist for the aggregate.
 *
 * @param {string} aggregateType
 * @param {string} aggregateId
 * @returns {number}
 */
export function getAggregateVersion(aggregateType, aggregateId) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(version), 0) AS v FROM domain_events
       WHERE aggregateType = ? AND aggregateId = ?`
    )
    .get(aggregateType, aggregateId);
  return row?.v ?? 0;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseEventRow(row) {
  let payload = {};
  let metadata = {};
  try { payload  = JSON.parse(row.payload  ?? "{}"); } catch { /* keep empty */ }
  try { metadata = JSON.parse(row.metadata ?? "{}"); } catch { /* keep empty */ }
  return { ...row, payload, metadata };
}

// ── Known event types ──────────────────────────────────────────────────────────

/**
 * Canonical event type strings. Centralising them here prevents typos and
 * makes grep-ability trivial.
 */
export const EventTypes = Object.freeze({
  // Contract lifecycle
  CONTRACT_INITIALIZED:           "ContractInitialized",
  // Distributions
  DISTRIBUTION_INITIATED:         "DistributionInitiated",
  DISTRIBUTION_CONFIRMED:         "DistributionConfirmed",
  DISTRIBUTION_FAILED:            "DistributionFailed",
  // Secondary sales
  SECONDARY_SALE_RECORDED:        "SecondarySaleRecorded",
  SECONDARY_ROYALTY_DISTRIBUTED:  "SecondaryRoyaltyDistributed",
  // Disputes
  DISPUTE_OPENED:                 "DisputeOpened",
  DISPUTE_RESOLVED:               "DisputeResolved",
  DISPUTE_ESCALATED:              "DisputeEscalated",
  // Collaborator
  COLLABORATOR_ADDED:             "CollaboratorAdded",
  COLLABORATOR_STATUS_CHANGED:    "CollaboratorStatusChanged",
  // Generic
  COMMAND_REJECTED:               "CommandRejected",
});

export const AggregateTypes = Object.freeze({
  CONTRACT:     "contract",
  COLLABORATOR: "collaborator",
  DISPUTE:      "dispute",
});
