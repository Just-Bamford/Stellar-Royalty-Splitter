/**
 * Indexed events database operations.
 * Provides search, filtering, and retrieval functions for indexed contract events.
 */

import { db } from "../database/index.js";
import { assertValidContractId } from "../contract-id.js";

export function searchIndexedEvents(contractId, filters = {}, limit = 50, offset = 0) {
  assertValidContractId(contractId);
  const { eventType, startLedger, endLedger, startDate, endDate, transactionHash, address } = filters;

  const whereConditions = [];
  const params = [];

  whereConditions.push("contract_id = ?");
  params.push(contractId);

  if (eventType) {
    whereConditions.push("event_type = ?");
    params.push(eventType);
  }

  if (startLedger) {
    whereConditions.push("ledger_sequence >= ?");
    params.push(parseInt(startLedger));
  }

  if (endLedger) {
    whereConditions.push("ledger_sequence <= ?");
    params.push(parseInt(endLedger));
  }

  if (startDate) {
    whereConditions.push("timestamp >= ?");
    params.push(startDate);
  }

  if (endDate) {
    whereConditions.push("timestamp <= ?");
    params.push(endDate);
  }

  if (transactionHash) {
    whereConditions.push("transaction_hash = ?");
    params.push(transactionHash);
  }

  const whereClause = `WHERE ${whereConditions.join(" AND ")}`;
  const sql = `
    SELECT 
      event_id,
      ledger_sequence,
      transaction_hash,
      event_index,
      timestamp,
      event_type,
      event_data,
      raw_event
    FROM indexed_events
    ${whereClause}
    ORDER BY timestamp DESC LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const stmt = db.prepare(sql);
  const events = stmt.all(...params);

  return events.map(parseEventRow);
}

export function countIndexedEvents(contractId, filters = {}) {
  assertValidContractId(contractId);
  const { eventType, startLedger, endLedger, startDate, endDate, transactionHash, address } = filters;

  const whereConditions = [];
  const params = [];

  whereConditions.push("contract_id = ?");
  params.push(contractId);

  if (eventType) {
    whereConditions.push("event_type = ?");
    params.push(eventType);
  }

  if (startLedger) {
    whereConditions.push("ledger_sequence >= ?");
    params.push(parseInt(startLedger));
  }

  if (endLedger) {
    whereConditions.push("ledger_sequence <= ?");
    params.push(parseInt(endLedger));
  }

  if (startDate) {
    whereConditions.push("timestamp >= ?");
    params.push(startDate);
  }
  
  if (endDate) {
    whereConditions.push("timestamp <= ?");
    params.push(endDate);
  }

  if (transactionHash) {
    whereConditions.push("transaction_hash = ?");
    params.push(transactionHash);
  }

  const sql = `
    SELECT COUNT(*) as total
    FROM indexed_events
    WHERE ${whereConditions.join(" AND ")}
  `;

  const stmt = db.prepare(sql);
  const result = stmt.get(...params);

  return result.total;
}

export function getEventStats(contractId) {
  assertValidContractId(contractId);
  const stmt = db.prepare(`
    SELECT 
      COUNT(*) as totalEvents,
      COUNT(DISTINCT event_type) as uniqueEventTypes,
      MIN(ledger_sequence) as firstLedger,
      MAX(ledger_sequence) as lastLedger,
      MIN(timestamp) as firstEventTimestamp,
      MAX(timestamp) as lastEventTimestamp,
      COUNT(DISTINCT transaction_hash) as totalTransactions
    FROM indexed_events
    WHERE contract_id = ?
  `);

  const stats = stmt.get(contractId);

  const eventTypeStmt = db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM indexed_events
    WHERE contract_id = ?
    GROUP BY event_type
    ORDER BY count DESC
    LIMIT 10
  `);

  const eventsByType = eventTypeStmt.all(contractId);

  const ledgerStmt = db.prepare(`
    SELECT ledger_sequence, COUNT(*) as eventCount
    FROM indexed_events
    WHERE contract_id = ?
    GROUP BY ledger_sequence
    ORDER BY ledger_sequence DESC
    LIMIT 20
  `);

  const eventsByLedger = ledgerStmt.all(contractId);

  return {
    totalEvents: stats.totalEvents,
    uniqueEventTypes: stats.uniqueEventTypes,
    firstLedger: stats.firstLedger,
    lastLedger: stats.lastLedger,
    firstEventTimestamp: stats.firstEventTimestamp,
    lastEventTimestamp: stats.lastEventTimestamp,
    totalTransactions: stats.totalTransactions,
    eventsByType,
    eventsByLedger,
  };
}

export function getIndexedEventById(eventId) {
  const stmt = db.prepare(`
    SELECT 
      event_id,
      ledger_sequence,
      transaction_hash,
      event_index,
      timestamp,
      contract_id,
      event_type,
      event_data,
      raw_event
    FROM indexed_events
    WHERE event_id = ?
  `);

  const event = stmt.get(eventId);
  return event ? parseEventRow(event) : null;
}

function parseEventRow(row) {
  try {
    let eventData = null;
    if (row.event_data) {
      eventData = JSON.parse(row.event_data);
    }

    let rawEvent = null;
    if (row.raw_event) {
      rawEvent = JSON.parse(row.raw_event);
    }

    return {
      ...row,
      event_data: eventData,
      raw_event: rawEvent,
    };
  } catch (err) {
    return row;
  }
}

export default {
  searchIndexedEvents,
  countIndexedEvents,
  getEventStats,
  getIndexedEventById,
};
