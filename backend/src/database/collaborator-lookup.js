import { db } from "./core.js";

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

function normalizeQuery(query) {
  return String(query || "").trim().toUpperCase();
}

function addSuggestion(map, address, source, contractId = null, lastSeen = null) {
  if (!STELLAR_ADDRESS_RE.test(address)) return;
  const existing = map.get(address);
  if (existing) {
    existing.sources = Array.from(new Set([...existing.sources, source]));
    if (lastSeen && (!existing.lastSeen || new Date(lastSeen) > new Date(existing.lastSeen))) {
      existing.lastSeen = lastSeen;
    }
    return;
  }

  map.set(address, {
    address,
    label: `${address.slice(0, 8)}…${address.slice(-6)}`,
    contractId,
    lastSeen,
    sources: [source],
  });
}

export function lookupCollaborators(query = "", limit = 10) {
  const normalized = normalizeQuery(query);
  const suggestions = new Map();

  const auditRows = db
    .prepare(`
      SELECT contractId, details, timestamp
      FROM audit_log
      WHERE action = 'contract_initialized'
      ORDER BY timestamp DESC
      LIMIT 500
    `)
    .all();

  for (const row of auditRows) {
    try {
      const details = JSON.parse(row.details || "{}");
      const collaborators = Array.isArray(details.collaborators) ? details.collaborators : [];
      collaborators.forEach((address) => addSuggestion(suggestions, address, "initialize_history", row.contractId, row.timestamp));
    } catch (_) {
      // Ignore malformed legacy audit details.
    }
  }

  const payoutRows = db
    .prepare(`
      SELECT dp.contractId, dp.collaboratorAddress AS address, t.timestamp
      FROM distribution_payouts dp
      LEFT JOIN transactions t ON t.id = dp.transactionId
      ORDER BY t.timestamp DESC
      LIMIT 500
    `)
    .all();

  payoutRows.forEach((row) => addSuggestion(suggestions, row.address, "payout_history", row.contractId, row.timestamp));

  return Array.from(suggestions.values())
    .filter((suggestion) => !normalized || suggestion.address.includes(normalized))
    .sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0))
    .slice(0, Math.min(Math.max(Number(limit) || 10, 1), 25));
}
