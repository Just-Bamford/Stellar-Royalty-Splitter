import { db, countWrite } from "./core.js";

export function placeHold(transactionId, holdReason, holdUntil, placedBy) {
  const existing = db.prepare("SELECT * FROM transactions WHERE id = ?").get(transactionId);
  if (!existing) return null;

  db.prepare(
    `
    UPDATE transactions SET
      hold_reason = ?,
      hold_until = ?,
      hold_placed_at = CURRENT_TIMESTAMP,
      hold_placed_by = ?,
      hold_status = 'active'
    WHERE id = ?
  `
  ).run(holdReason, holdUntil, placedBy, transactionId);
  countWrite();

  db.prepare(
    "INSERT INTO hold_audit (transactionId, action, reason, performedBy, details) VALUES (?, 'placed', ?, ?, ?)"
  ).run(transactionId, holdReason, placedBy, JSON.stringify({ holdUntil }));
  countWrite();

  return getTransactionWithHold(transactionId);
}

export function releaseHold(transactionId, releasedBy, approvalNote) {
  const existing = db
    .prepare("SELECT * FROM transactions WHERE id = ? AND hold_status = 'active'")
    .get(transactionId);
  if (!existing) return null;

  db.prepare(
    `
    UPDATE transactions SET
      hold_status = 'released',
      hold_released_at = CURRENT_TIMESTAMP,
      hold_released_by = ?
    WHERE id = ?
  `
  ).run(releasedBy, transactionId);
  countWrite();

  db.prepare(
    "INSERT INTO hold_audit (transactionId, action, reason, performedBy, details) VALUES (?, 'released', ?, ?, ?)"
  ).run(
    transactionId,
    approvalNote ?? "Released",
    releasedBy,
    JSON.stringify({ releasedAt: new Date().toISOString() })
  );
  countWrite();

  return getTransactionWithHold(transactionId);
}

export function approveHoldRelease(transactionId, approvedBy, approvalNote) {
  const existing = db
    .prepare("SELECT * FROM transactions WHERE id = ? AND hold_status = 'active'")
    .get(transactionId);
  if (!existing) return null;

  db.prepare(
    `
    UPDATE transactions SET
      hold_approved_by = ?,
      hold_approved_at = CURRENT_TIMESTAMP,
      hold_approval_note = ?
    WHERE id = ?
  `
  ).run(approvedBy, approvalNote ?? null, transactionId);
  countWrite();

  db.prepare(
    "INSERT INTO hold_audit (transactionId, action, reason, performedBy, details) VALUES (?, 'approved', ?, ?, ?)"
  ).run(transactionId, "Approved for release", approvedBy, JSON.stringify({ note: approvalNote }));
  countWrite();

  return getTransactionWithHold(transactionId);
}

export function getTransactionWithHold(transactionId) {
  return db.prepare("SELECT * FROM transactions WHERE id = ?").get(transactionId) ?? null;
}

export function getHeldTransactions(contractId, status = "active") {
  return db
    .prepare(
      "SELECT * FROM transactions WHERE contractId = ? AND hold_status = ? ORDER BY hold_placed_at DESC"
    )
    .all(contractId, status);
}

export function getAllHeldTransactions(status = "active") {
  return db
    .prepare("SELECT * FROM transactions WHERE hold_status = ? ORDER BY hold_placed_at DESC")
    .all(status);
}

export function getHoldAuditTrail(transactionId) {
  return db
    .prepare("SELECT * FROM hold_audit WHERE transactionId = ? ORDER BY created_at ASC")
    .all(transactionId);
}

export function getTransactionsPendingHoldRelease() {
  return db
    .prepare(
      "SELECT * FROM transactions WHERE hold_status = 'active' AND hold_approved_by IS NOT NULL ORDER BY hold_approved_at ASC"
    )
    .all();
}
