import { db, countWrite } from "./core.js";

/**
 * Record the start of a request.
 */
export function recordRequestStart(transactionId, correlationId, method, path, requestBody) {
  const stmt = db.prepare(`
    INSERT INTO request_tracking 
    (transactionId, correlationId, method, path, requestBody)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    transactionId,
    correlationId,
    method,
    path,
    requestBody ? JSON.stringify(requestBody) : null
  );
  countWrite();
}

/**
 * Record the end/response of a request.
 */
export function recordRequestEnd(transactionId, responseStatus, responseBody) {
  const stmt = db.prepare(`
    UPDATE request_tracking 
    SET responseStatus = ?, responseBody = ? 
    WHERE transactionId = ?
  `);
  stmt.run(
    responseStatus,
    responseBody ? JSON.stringify(responseBody) : null,
    transactionId
  );
  countWrite();
}

/**
 * Fetch tracking details by transaction ID.
 */
export function getRequestTracking(transactionId) {
  const stmt = db.prepare(`
    SELECT * FROM request_tracking 
    WHERE transactionId = ?
  `);
  return stmt.get(transactionId);
}

/**
 * Clean up tracking records older than 30 days.
 */
export function cleanupRequestTracking() {
  const stmt = db.prepare(`
    DELETE FROM request_tracking 
    WHERE timestamp < datetime('now', '-30 days')
  `);
  const result = stmt.run();
  countWrite();
  return result.changes;
}
