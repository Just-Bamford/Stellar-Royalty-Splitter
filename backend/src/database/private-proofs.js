import crypto from "crypto";
import { db, countWrite } from "./core.js";

const SUPPORTED_TYPES = new Set(["distribution", "membership", "allocation"]);

export function createPrivateProof({ walletAddress, proofType, witness, publicSignals = [] }) {
  if (!SUPPORTED_TYPES.has(proofType)) throw new Error(`Unsupported proof type: ${proofType}`);
  if (!witness || typeof witness !== "object") throw new Error("witness is required");
  const nonce = crypto.randomBytes(16).toString("hex");
  const commitment = crypto
    .createHash("sha256")
    .update(JSON.stringify({ proofType, witness, nonce }))
    .digest("hex");
  const proof = JSON.stringify({ version: 1, scheme: "commitment-envelope", commitment, nonce });
  const result = db
    .prepare(
      `INSERT INTO private_proofs (walletAddress, proofType, commitment, proof, publicSignals) VALUES (?, ?, ?, ?, ?)`
    )
    .run(walletAddress, proofType, commitment, proof, JSON.stringify(publicSignals));
  countWrite();
  return {
    id: Number(result.lastInsertRowid),
    walletAddress,
    proofType,
    commitment,
    proof: JSON.parse(proof),
    publicSignals,
  };
}

export function verifyPrivateProof({ proof, commitment, proofType, publicSignals = [] }) {
  if (!proof || proof.scheme !== "commitment-envelope" || proof.version !== 1)
    return { valid: false, reason: "unsupported_proof_format" };
  if (proof.commitment !== commitment) return { valid: false, reason: "commitment_mismatch" };
  const record = db
    .prepare("SELECT * FROM private_proofs WHERE commitment = ? AND proofType = ?")
    .get(commitment, proofType);
  if (!record) return { valid: false, reason: "unknown_commitment" };
  const expectedSignals = JSON.parse(record.publicSignals || "[]");
  return {
    valid: JSON.stringify(expectedSignals) === JSON.stringify(publicSignals),
    reason:
      JSON.stringify(expectedSignals) === JSON.stringify(publicSignals)
        ? null
        : "public_signals_mismatch",
  };
}

export function listPrivateProofs(walletAddress, limit = 50) {
  return db
    .prepare(
      "SELECT id, walletAddress, proofType, commitment, publicSignals, createdAt FROM private_proofs WHERE walletAddress = ? ORDER BY createdAt DESC LIMIT ?"
    )
    .all(walletAddress, limit)
    .map((row) => ({ ...row, publicSignals: JSON.parse(row.publicSignals || "[]") }));
}
