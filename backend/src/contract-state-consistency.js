import logger from "./logger.js";
import { getContractStateSnapshot } from "./stellar.js";
import { addAuditLog, db } from "./database/index.js";
import { recordContractConsistencyCheck } from "./metrics.js";

const INITIALIZE_ACTIONS = new Set(["contract_initialized", "initialize_revealed"]);

function parseDetails(details) {
  if (!details) return null;
  if (typeof details === "object") return details;

  try {
    return JSON.parse(details);
  } catch {
    return null;
  }
}

function normalizeRecipients(collaborators = [], shares = []) {
  return collaborators
    .map((address, index) => ({
      address,
      basisPoints: Number(shares[index] ?? 0),
    }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

function normalizeOnChainRecipients(recipients = []) {
  return recipients
    .map((recipient) => ({
      address: recipient.address,
      basisPoints: Number(recipient.basisPoints),
    }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

function decimalStringToIntegerString(value) {
  if (value == null) return "0";
  const raw = String(value);
  if (!raw.includes(".")) return raw;

  const number = Number(raw);
  return Number.isFinite(number) ? String(Math.trunc(number)) : raw;
}

export function getKnownContractIds() {
  const rows = db
    .prepare(
      `
        SELECT contractId FROM transactions
        UNION
        SELECT contractId FROM secondary_sales
        UNION
        SELECT contractId FROM audit_log
      `,
    )
    .all();

  return rows.map((row) => row.contractId).filter(Boolean);
}

export function getExpectedContractStateFromDb(contractId) {
  const initRows = db
    .prepare(
      `
        SELECT user, details, timestamp
        FROM audit_log
        WHERE contractId = ?
          AND action IN ('contract_initialized', 'initialize_revealed')
        ORDER BY id DESC
        LIMIT 1
      `,
    )
    .all(contractId);
  const initDetails = parseDetails(initRows[0]?.details);
  const collaborators = initDetails?.collaborators ?? null;
  const shares = initDetails?.shares ?? null;

  const rateRow = db
    .prepare(
      `
        SELECT details
        FROM audit_log
        WHERE contractId = ?
          AND action = 'royalty_rate_set'
        ORDER BY id DESC
        LIMIT 1
      `,
    )
    .get(contractId);
  const rateDetails = parseDetails(rateRow?.details);

  const pendingPoolRow = db
    .prepare(
      `
        SELECT COALESCE(SUM(CAST(royaltyAmount AS INTEGER)), 0) AS pendingPool
        FROM secondary_sales
        WHERE contractId = ?
          AND distributed = 0
      `,
    )
    .get(contractId);

  return {
    contractId,
    hasInitializationRecord: Array.isArray(collaborators) && Array.isArray(shares),
    initialized: Array.isArray(collaborators) && Array.isArray(shares),
    adminAddress: Array.isArray(collaborators) ? collaborators[0] ?? null : null,
    recipients:
      Array.isArray(collaborators) && Array.isArray(shares)
        ? normalizeRecipients(collaborators, shares)
        : null,
    totalShares: Array.isArray(shares)
      ? shares.reduce((sum, share) => sum + Number(share ?? 0), 0)
      : null,
    royaltyRate:
      rateDetails?.royaltyRate == null ? null : Number(rateDetails.royaltyRate),
    secondaryPool: decimalStringToIntegerString(pendingPoolRow?.pendingPool ?? "0"),
  };
}

function pushMismatch(discrepancies, field, expected, actual, severity = "warning") {
  discrepancies.push({ field, expected, actual, severity });
}

export function compareContractStates(expected, actual) {
  const discrepancies = [];

  if (expected.initialized !== actual.initialized) {
    pushMismatch(discrepancies, "initialized", expected.initialized, actual.initialized, "critical");
  }

  if (expected.adminAddress && expected.adminAddress !== actual.adminAddress) {
    pushMismatch(discrepancies, "adminAddress", expected.adminAddress, actual.adminAddress, "critical");
  }

  if (expected.recipients) {
    const onChainRecipients = normalizeOnChainRecipients(actual.recipients);
    if (JSON.stringify(expected.recipients) !== JSON.stringify(onChainRecipients)) {
      pushMismatch(discrepancies, "recipients", expected.recipients, onChainRecipients, "critical");
    }
  }

  if (expected.totalShares != null && expected.totalShares !== actual.totalShares) {
    pushMismatch(discrepancies, "totalShares", expected.totalShares, actual.totalShares, "critical");
  }

  if (expected.royaltyRate != null && expected.royaltyRate !== actual.royaltyRate) {
    pushMismatch(discrepancies, "royaltyRate", expected.royaltyRate, actual.royaltyRate);
  }

  if (expected.secondaryPool !== actual.secondaryPool) {
    pushMismatch(discrepancies, "secondaryPool", expected.secondaryPool, actual.secondaryPool, "critical");
  }

  return discrepancies;
}

export async function verifyContractStateConsistency(contractId, options = {}) {
  const {
    expectedStateReader = getExpectedContractStateFromDb,
    onChainStateReader = getContractStateSnapshot,
    audit = true,
    log = logger,
  } = options;

  try {
    const [expected, actual] = await Promise.all([
      expectedStateReader(contractId),
      onChainStateReader(contractId),
    ]);
    const discrepancies = compareContractStates(expected, actual);
    const consistent = discrepancies.length === 0;

    const result = {
      contractId,
      checkedAt: new Date().toISOString(),
      consistent,
      discrepancyCount: discrepancies.length,
      discrepancies,
      expected,
      actual,
    };

    recordContractConsistencyCheck({
      success: true,
      discrepancyCount: discrepancies.length,
    });

    if (!consistent) {
      log.error("Contract state consistency discrepancies detected", {
        contractId,
        discrepancyCount: discrepancies.length,
        discrepancies,
      });

      if (audit) {
        addAuditLog(contractId, "contract_state_discrepancy_detected", "system", {
          discrepancyCount: discrepancies.length,
          discrepancies,
        });
      }
    } else {
      log.info("Contract state consistency verification passed", { contractId });
    }

    return result;
  } catch (err) {
    recordContractConsistencyCheck({ success: false, discrepancyCount: 0 });
    log.error("Contract state consistency verification failed", {
      contractId,
      error: err.message ?? String(err),
    });
    throw err;
  }
}

export async function verifyAllContractStateConsistency(contractIds, options = {}) {
  const uniqueIds = [...new Set(contractIds.filter(Boolean))];
  const results = [];

  for (const contractId of uniqueIds) {
    results.push(await verifyContractStateConsistency(contractId, options));
  }

  return {
    checkedAt: new Date().toISOString(),
    contractCount: uniqueIds.length,
    inconsistentCount: results.filter((result) => !result.consistent).length,
    results,
  };
}

export const _test = {
  INITIALIZE_ACTIONS,
  parseDetails,
  normalizeRecipients,
  normalizeOnChainRecipients,
  decimalStringToIntegerString,
};
