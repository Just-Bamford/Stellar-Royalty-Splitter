import logger from "../logger.js";
import { getConfiguredContractId } from "../stellar.js";
import {
  getKnownContractIds,
  verifyAllContractStateConsistency,
} from "../contract-state-consistency.js";

export const CONTRACT_STATE_CONSISTENCY_INTERVAL_MS = 60 * 60 * 1000;

let consistencyInterval = null;
let isRunning = false;

function getContractsToVerify() {
  const configured = getConfiguredContractId();
  return [...new Set([configured, ...getKnownContractIds()].filter(Boolean))];
}

async function runConsistencyBatch() {
  if (isRunning) {
    logger.debug("Contract state consistency job already running, skipping cycle");
    return null;
  }

  isRunning = true;
  try {
    const contractIds = getContractsToVerify();
    if (contractIds.length === 0) {
      logger.info("Contract state consistency job skipped: no contracts found");
      return { contractCount: 0, results: [] };
    }

    logger.info("Contract state consistency job started", {
      contractCount: contractIds.length,
    });

    const result = await verifyAllContractStateConsistency(contractIds);
    logger.info("Contract state consistency job finished", {
      contractCount: result.contractCount,
      inconsistentCount: result.inconsistentCount,
    });

    return result;
  } catch (err) {
    logger.error("Contract state consistency job failed", {
      error: err.message ?? String(err),
    });
    throw err;
  } finally {
    isRunning = false;
  }
}

export function startContractStateConsistencyJob() {
  if (consistencyInterval) {
    logger.warn("Contract state consistency job already running");
    return;
  }

  logger.info("Starting contract state consistency job", {
    intervalMs: CONTRACT_STATE_CONSISTENCY_INTERVAL_MS,
  });

  consistencyInterval = setInterval(
    () => runConsistencyBatch().catch(() => {}),
    CONTRACT_STATE_CONSISTENCY_INTERVAL_MS,
  );
  runConsistencyBatch().catch(() => {});
}

export function stopContractStateConsistencyJob() {
  if (!consistencyInterval) return;

  clearInterval(consistencyInterval);
  consistencyInterval = null;
  logger.info("Stopped contract state consistency job");
}

export async function triggerContractStateConsistencyCheck(contractIds = null) {
  if (Array.isArray(contractIds) && contractIds.length > 0) {
    return verifyAllContractStateConsistency(contractIds);
  }

  return runConsistencyBatch();
}

export const _test = {
  getContractsToVerify,
  runConsistencyBatch,
  get isRunning() {
    return isRunning;
  },
  get consistencyInterval() {
    return consistencyInterval;
  },
};
