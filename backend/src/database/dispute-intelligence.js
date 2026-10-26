import crypto from "crypto";
import { db, countWrite } from "./core.js";

export function addEvidence({ disputeId, walletAddress, kind, content }) {
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  const result = db
    .prepare(
      `
    INSERT INTO dispute_evidence (disputeId, walletAddress, kind, content, contentHash)
    VALUES (?, ?, ?, ?, ?)
  `
    )
    .run(disputeId, walletAddress, kind, content, contentHash);
  countWrite();
  return db.prepare("SELECT * FROM dispute_evidence WHERE id = ?").get(result.lastInsertRowid);
}

export function listEvidence(disputeId) {
  return db
    .prepare(
      "SELECT id, disputeId, walletAddress, kind, contentHash, createdAt FROM dispute_evidence WHERE disputeId = ? ORDER BY createdAt ASC"
    )
    .all(disputeId);
}

export function analyzeDispute(disputeId) {
  const evidence = db
    .prepare(
      "SELECT kind, content FROM dispute_evidence WHERE disputeId = ? ORDER BY createdAt ASC"
    )
    .all(disputeId);
  const text = evidence.map((item) => item.content.toLowerCase()).join(" ");
  const hasPaymentProof =
    evidence.some((item) => ["transaction_proof", "receipt", "tx_hash"].includes(item.kind)) ||
    /tx|hash|payment|payout/.test(text);
  const hasAgreement =
    evidence.some((item) => ["agreement", "contract"].includes(item.kind)) ||
    /agreement|contract|share|allocation/.test(text);
  const recommendation =
    hasPaymentProof && hasAgreement
      ? "request_counterparty_review"
      : hasPaymentProof
        ? "review_payment_records"
        : "collect_more_evidence";
  const confidence = Math.min(
    0.95,
    0.35 +
      (hasPaymentProof ? 0.3 : 0) +
      (hasAgreement ? 0.25 : 0) +
      Math.min(0.1, evidence.length * 0.02)
  );
  const findings = {
    evidenceCount: evidence.length,
    hasPaymentProof,
    hasAgreement,
    signals: [hasPaymentProof && "payment_evidence", hasAgreement && "agreement_evidence"].filter(
      Boolean
    ),
  };
  const result = db
    .prepare(
      `
    INSERT INTO dispute_analyses (disputeId, provider, findings, recommendation, confidence)
    VALUES (?, 'deterministic-mediation-v1', ?, ?, ?)
  `
    )
    .run(disputeId, JSON.stringify(findings), recommendation, confidence);
  countWrite();
  return {
    id: Number(result.lastInsertRowid),
    disputeId,
    provider: "deterministic-mediation-v1",
    findings,
    recommendation,
    confidence,
  };
}

export function getLatestAnalysis(disputeId) {
  const row = db
    .prepare("SELECT * FROM dispute_analyses WHERE disputeId = ? ORDER BY createdAt DESC LIMIT 1")
    .get(disputeId);
  return row ? { ...row, findings: JSON.parse(row.findings) } : null;
}
