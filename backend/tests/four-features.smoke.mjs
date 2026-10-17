import { db, initializeDatabase, closeDatabase } from "../src/database/index.js";
import { recordReputationEvent, computeTrustScore } from "../src/database/reputation.js";
import { addEvidence, analyzeDispute, listEvidence } from "../src/database/dispute-intelligence.js";
import { indexDocument, searchDocuments } from "../src/database/search.js";
import { createPrivateProof, verifyPrivateProof } from "../src/database/private-proofs.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS disputes (id INTEGER PRIMARY KEY, ticketId TEXT, walletAddress TEXT, status TEXT);
`);
for (let version = 1; version <= 14; version += 1)
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)").run(version);
initializeDatabase();
const wallet = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
recordReputationEvent({ walletAddress: wallet, eventType: "payment", successful: true });
const reputation = computeTrustScore(wallet);
db.prepare(
  "INSERT INTO disputes (id, ticketId, walletAddress, status) VALUES (1, 'DSP-1', ?, 'open')"
).run(wallet);
addEvidence({
  disputeId: 1,
  walletAddress: wallet,
  kind: "transaction_proof",
  content: "tx hash proves payment",
});
addEvidence({
  disputeId: 1,
  walletAddress: wallet,
  kind: "agreement",
  content: "signed share agreement",
});
const analysis = analyzeDispute(1);
indexDocument({
  entityType: "dispute",
  entityId: "DSP-1",
  title: "Missing payment",
  body: "Payment evidence and transaction proof",
});
const results = searchDocuments("payment evidence");
const created = createPrivateProof({
  walletAddress: wallet,
  proofType: "distribution",
  witness: { amount: "hidden" },
  publicSignals: ["set-member"],
});
const verified = verifyPrivateProof({
  proof: created.proof,
  commitment: created.commitment,
  proofType: "distribution",
  publicSignals: ["set-member"],
});
if (
  reputation.trustScore !== 70 ||
  listEvidence(1).length !== 2 ||
  analysis.recommendation !== "request_counterparty_review" ||
  results.length !== 1 ||
  !verified.valid
)
  throw new Error("feature smoke test failed");
console.log(
  JSON.stringify({
    reputation,
    evidence: 2,
    recommendation: analysis.recommendation,
    resultCount: results.length,
    verified,
  })
);
closeDatabase();
