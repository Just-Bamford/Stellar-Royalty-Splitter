import { Router } from "express";
import StellarSdk from "@stellar/stellar-sdk";
import {
  isContractInitialized,
  server,
  networkPassphrase,
  addressToScVal,
  getConfiguredContractId,
  getContractVersionFromContract,
  getNetworkLabel,
} from "../stellar.js";
import { validateContractIdMiddleware, validateContractId } from "../validation.js";
import { sendError } from "../error-response.js";
import { cacheGet, cacheSet, cacheKey, TTL, clearCache } from "../cache.js";

const { Contract, SorobanRpc, TransactionBuilder, BASE_FEE, Account } = StellarSdk;

export const contractRouter = Router();

// ---- Cache warming infrastructure ----
// This implements human friendly cache warming with stale data support.
// Note: In a production system, this would query an "active-contracts" table
// to determine which contracts to warm. Here we use access frequency as a proxy.
const CACHE_WARM_LEAD_TIME_MS = parseInt(process.env.CACHE_WARM_LEAD_TIME_MS || "30000", 10);

// Metadata for cache entries: tracks expiration, timers, stale value, etc.
const cacheMetadata = new Map();

const metrics = {
  hits: 0,
  misses: 0,
  staleServes: 0,
  refreshLatencyMs: [],
};

// Log metrics periodically (only outside Jest test environment)
let metricsInterval = null;
const isTestEnvironment = typeof global.jest !== "undefined";
if (!isTestEnvironment) {
  metricsInterval = setInterval(() => {
    console.log(
      `[cache-warm] hits ${metrics.hits}, misses ${metrics.misses}, stale-serves ${metrics.staleServes}`
    );
    if (metrics.refreshLatencyMs.length > 0) {
      console.log(
        `[cache-warm] avg refresh-latency: ${metrics.refreshLatencyMs.reduce((a, b) => a + b, 0) / metrics.refreshLatencyMs.length} ms`
      );
    }
  }, 60 * 1000);

  // Allow this interval to not block process exit
  if (metricsInterval.unref) {
    metricsInterval.unref();
  }
}

// Export cleanup function for tests
export function cleanupMetricsInterval() {
  if (metricsInterval) clearInterval(metricsInterval);
}

// Export for test cleanup
export { metricsInterval };

function getMetadata(key) {
  let meta = cacheMetadata.get(key);
  if (!meta) {
    meta = {
      expiresAt: 0,
      refreshAt: 0,
      inFlight: false,
      staleValue: null, // last known value for stale reads
      timer: null,
      contractId: null,
      tokenId: null,
      accessCount: 0,
    };
    cacheMetadata.set(key, meta);
  }
  return meta;
}

function scheduleRefresh(key, contractId, tokenId, delayMm) {
  const meta = getMetadata(key);
  if (meta.timer) clearTimeout(meta.timer);
  meta.timer = setTimeout(() => {
    refreshContractState(key, contractId, tokenId);
  }, delayMm);
  if (meta.timer.unref) meta.timer.unref(); // Don't keep process alive
  // Store contract/id for refresh operations.
  meta.contractId = contractId;
  meta.tokenId = tokenId;
}

async function refreshContractState(key, contractId, tokenId) {
  const meta = getMetadata(key);
  if (meta.inFlight) return; // Prevent duplicate refreshes
  meta.inFlight = true;
  const start = Date.now();
  try {
    const state = await readContractState(contractId, tokenId);
    cacheSet(key, state, TTL.contractState);
    const now = Date.now();
    const expiresAt = now + TTL.contractState * 1000;
    meta.expiresAt = expiresAt;
    meta.refreshAt = expiresAt - CACHE_WARM_LEAD_TIME_MS;
    meta.staleValue = null; // clear stale since fresh data is available
    // Schedule next refresh.
    scheduleRefresh(key, contractId, tokenId, CACHE_WARM_LEAD_TIME_MS);
    metrics.refreshLatencyMs.push(Date.now() - start);
  } catch (err) {
    // Graceful degradation: keep stale data if refresh fails.
    console.error(`Cache refresh failed for contract contractId: ${err.message}`);
  } finally {
    meta.inFlight = false;
  }
}

function warmCacheGet(key) {
  const meta = getMetadata(key);
  const cached = cacheGet(key);
  if (cached !== undefined) {
    // Fresh cache hit.
    metrics.hits++;
    meta.accessCount++;
    // Trigger refresh early if we are within lead time window.
    if (meta.expiresAt - Date.now() <= CACHE_WARM_LEAD_TIME_MS && !meta.inFlight) {
      scheduleRefresh(key, meta.contractId, meta.tokenId, 0);
    }
    return cached;
  }

  // Cache miss or expired: check for stale value.
  if (meta.staleValue !== null && meta.expiresAt > 0) {
    // Serve stale data and trigger background refresh.
    metrics.staleServes++;
    meta.accessCount++;
    if (!meta.inFlight) {
      refreshContractState(key, meta.contractId, meta.tokenId);
    }
    return meta.staleValue;
  }

  // True miss: no cache and no stale.
  metrics.misses++;
  return undefined;
}

function warmCacheSet(key, value, contractId, tokenId) {
  cacheSet(key, value, TTL.contractState);
  const now = Date.now();
  const expiresAt = now + TTL.contractState * 1000;
  const meta = getMetadata(key);
  meta.expiresAt = expiresAt;
  meta.refreshAt = expiresAt - CACHE_WARM_LEAD_TIME_MS;
  meta.staleValue = value; // snapshot for potential stale serving
  meta.contractId = contractId;
  meta.tokenId = tokenId;
  scheduleRefresh(key, contractId, tokenId, CACHE_WARM_LEAD_TIME_MS);
}

// ---- End of cache warming code ----

function getConfiguredTokenId() {
  return (
    process.env.ROYALTY_TOKEN_ID ?? process.env.TOKEN_CONTRACT_ID ?? process.env.TOKEN_ID ?? null
  );
}

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function i128ScValToString(scVal) {
  const i128 = scVal?.i128?.();
  if (!i128) return "0";
  return ((BigInt(i128.hi()) << 64n) | BigInt(i128.lo())).toString();
}

function decodeShareMap(scVal) {
  const mapEntries = scVal?.map?.()?.entries ?? [];
  return mapEntries.map((entry) => ({
    address: StellarSdk.Address.fromScVal(entry.key()).toString(),
    basisPoints: entry.val().u32(),
  }));
}

async function simulateContractRead(contractId, method, args = []) {
  const contract = new Contract(contractId);
  const dummyAccount = new Account("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJ5IAJTGKIN2ER7LBNVKOCCWN", "0");
  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    const error = new Error(sim.error ?? `${method} simulation failed`);
    error.status = 400;
    throw error;
  }

  return sim.result?.retval ?? null;
}

async function readContractState(contractId, tokenId) {
  const [adminVal, royaltyRateVal, recipientsVal, balanceVal] = await Promise.all([
    simulateContractRead(contractId, "get_admin"),
    simulateContractRead(contractId, "get_royalty_rate"),
    simulateContractRead(contractId, "get_all_shares"),
    simulateContractRead(contractId, "get_balance", [addressToScVal(tokenId)]),
  ]);

  return {
    contractId,
    adminAddress: adminVal ? StellarSdk.Address.fromScVal(adminVal).toString() : null,
    royaltyRate: royaltyRateVal?.u32?.() ?? 0,
    recipients: decodeShareMap(recipientsVal),
    balance: i128ScValToString(balanceVal),
    tokenId,
    network: getNetworkLabel(),
    networkPassphrase,
  };
}

function resolveStateRequest(req, res) {
  const contractId = firstQueryValue(req.query.contractId) ?? getConfiguredContractId();
  const tokenId = firstQueryValue(req.query.tokenId) ?? getConfiguredTokenId();

  if (!contractId) {
    sendError(
      res,
      400,
      "bad_request",
      "contractId query param required when no default contract is configured"
    );
    return null;
  }

  if (!validateContractId(contractId, res)) return null;

  if (!tokenId) {
    sendError(
      res,
      400,
      "bad_request",
      "tokenId query param required when no default token is configured"
    );
    return null;
  }

  if (!validateContractId(tokenId, res)) return null;

  return { contractId, tokenId };
}

export function _resetContractStateCache() {
  clearCache();
  cacheMetadata.clear();
}

contractRouter.get("/state", async (req, res, next) => {
  try {
    const stateRequest = resolveStateRequest(req, res);
    if (!stateRequest) return;

    const { contractId, tokenId } = stateRequest;
    const key = cacheKey("contractState", contractId, tokenId);

    // Check for collaborator pagination params
    const loadFull = req.query.loadFull === "true";
    const hasOffsetLimit = req.query.offset !== undefined || req.query.limit !== undefined;

    let state = warmCacheGet(key);
    if (state === undefined) {
      state = await readContractState(contractId, tokenId);
      warmCacheSet(key, state, contractId, tokenId);
    }

    // If requesting a subset of collaborators, slice the recipients array
    if (!loadFull && hasOffsetLimit && state.recipients) {
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
      const totalCollaborators = state.recipients.length;
      const sliced = state.recipients.slice(offset, offset + limit);

      return res.json({
        ...state,
        recipients: sliced,
        collaborators_pagination: {
          offset,
          limit,
          total: totalCollaborators,
          hasNextPage: offset + limit < totalCollaborators,
          hasPrevPage: offset > 0,
        },
      });
    }

    res.json(state);
  } catch (err) {
    if (err.status) {
      return sendError(res, err.status, undefined, err.message);
    }
    next(err);
  }
});

contractRouter.get("/info", async (req, res, next) => {
  try {
    const stateRequest = resolveStateRequest(req, res);
    if (!stateRequest) return;

    const { contractId, tokenId } = stateRequest;
    const key = cacheKey("contractState", contractId, tokenId);

    let state = warmCacheGet(key);
    if (state === undefined) {
      state = await readContractState(contractId, tokenId);
      warmCacheSet(key, state, contractId, tokenId);
    }

    const info = { ...state };
    delete info.networkPassphrase;

    // Apply collaborator pagination if requested
    const loadFull = req.query.loadFull === "true";
    const hasOffsetLimit = req.query.offset !== undefined || req.query.limit !== undefined;

    if (!loadFull && hasOffsetLimit && info.recipients) {
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
      const totalCollaborators = info.recipients.length;
      info.recipients = info.recipients.slice(offset, offset + limit);
      info.collaborators_pagination = {
        offset,
        limit,
        total: totalCollaborators,
        hasNextPage: offset + limit < totalCollaborators,
        hasPrevPage: offset > 0,
      };
    }

    res.json(info);
  } catch (err) {
    if (err.status) {
      return sendError(res, err.status, undefined, err.message);
    }
    next(err);
  }
});

contractRouter.get("/status/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const initialized = await isContractInitialized(contractId);
    res.json({ initialized });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/contract/balance/:contractId?tokenId=...
 * Returns the contract's token balance via simulation.
 * Response: { balance: string }
 */
contractRouter.get("/balance/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const { tokenId } = req.query;
    if (!tokenId) return sendError(res, 400, "bad_request", "tokenId query param required");
    if (!validateContractId(tokenId, res)) return;

    const contract = new Contract(contractId);
    const dummyAccount = new Account("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJ5IAJTGKIN2ER7LBNVKOCCWN", "0");
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call("get_balance", addressToScVal(tokenId)))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      return sendError(res, 400, "contract_simulation_failed", sim.error ?? "Simulation failed");
    }

    const retval = sim.result?.retval;
    // get_balance returns i128
    const balance = retval?.i128?.()
      ? ((BigInt(retval.i128().hi()) << 64n) | BigInt(retval.i128().lo())).toString()
      : "0";

    res.json({ balance });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/contract/collaborator-count/:contractId
 * Returns the number of collaborators via simulation.
 * Response: { contractId, count: number }
 */
contractRouter.get(
  "/collaborator-count/:contractId",
  validateContractIdMiddleware,
  async (req, res, next) => {
    try {
      const { contractId } = req.params;
      const contract = new Contract(contractId);
      const dummyAccount = new Account(
        "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJ5IAJTGKIN2ER7LBNVKOCCWN",
        "0"
      );
      const tx = new TransactionBuilder(dummyAccount, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(contract.call("collaborator_count"))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) {
        return sendError(res, 400, "contract_simulation_failed", sim.error ?? "Simulation failed");
      }

      const count = sim.result?.retval?.u32?.() ?? 0;
      res.json({ contractId, count });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/contract/shares-total/:contractId
 * Returns the sum of all collaborator shares via simulation.
 * Response: { contractId, totalShares: number }
 */
contractRouter.get(
  "/shares-total/:contractId",
  validateContractIdMiddleware,
  async (req, res, next) => {
    try {
      const { contractId } = req.params;
      const contract = new Contract(contractId);

      const dummyAccount = new Account(
        "GAAZI4PCR3TY5OJHCTJC2A4QSY6CJWJ5IAJTGKIN2ER7LBNVKOCCWN",
        "0"
      );
      const tx = new TransactionBuilder(dummyAccount, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(contract.call("get_total_shares"))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) {
        return sendError(res, 400, "contract_simulation_failed", sim.error ?? "Simulation failed");
      }

      const resultVal = sim.result?.retval;
      const totalShares = resultVal?.u32?.() ?? 0;

      res.json({ contractId, totalShares });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/contract/version/:contractId
 * Returns the on-chain contract version via simulation.
 * Response: { contractId, version: string }
 */
contractRouter.get("/version/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const initialized = await isContractInitialized(contractId);
    if (!initialized) {
      return sendError(res, 404, "not_found", "contract not initialized");
    }

    const version = await getContractVersionFromContract(contractId);
    if (!version) {
      return sendError(res, 404, "not_found", "contract version unavailable");
    }

    res.json({ contractId, version });
  } catch (err) {
    next(err);
  }
});
