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

const { Contract, SorobanRpc, TransactionBuilder, BASE_FEE, Account } = StellarSdk;

export const contractRouter = Router();

const CONTRACT_STATE_CACHE_TTL_MS = 30_000;
const contractStateCache = new Map();

function getConfiguredTokenId() {
  return (
    process.env.ROYALTY_TOKEN_ID ??
    process.env.TOKEN_CONTRACT_ID ??
    process.env.TOKEN_ID ??
    null
  );
}

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function shouldBypassCache(value) {
  const normalized = String(firstQueryValue(value) ?? "").toLowerCase();
  return normalized === "false" || normalized === "0" || normalized === "no";
}

function withCacheMetadata(state, cacheStatus, fetchedAt) {
  return {
    ...state,
    cacheStatus,
    cacheTtlMs: CONTRACT_STATE_CACHE_TTL_MS,
    fetchedAt: new Date(fetchedAt).toISOString(),
  };
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
  const dummyAccount = new Account(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    "0",
  );
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

function getContractStateCacheKey(contractId, tokenId) {
  return `${getNetworkLabel()}:${networkPassphrase}:${contractId}:${tokenId}`;
}

function resolveStateRequest(req, res) {
  const contractId = firstQueryValue(req.query.contractId) ?? getConfiguredContractId();
  const tokenId = firstQueryValue(req.query.tokenId) ?? getConfiguredTokenId();

  if (!contractId) {
    res.status(400).json({
      error: "contractId query param required when no default contract is configured",
    });
    return null;
  }

  if (!validateContractId(contractId, res)) return null;

  if (!tokenId) {
    res.status(400).json({
      error: "tokenId query param required when no default token is configured",
    });
    return null;
  }

  if (!validateContractId(tokenId, res)) return null;

  return { contractId, tokenId };
}

export function _resetContractStateCache() {
  contractStateCache.clear();
}

contractRouter.get("/state", async (req, res, next) => {
  try {
    const stateRequest = resolveStateRequest(req, res);
    if (!stateRequest) return;

    const { contractId, tokenId } = stateRequest;
    const cacheKey = getContractStateCacheKey(contractId, tokenId);
    const cached = contractStateCache.get(cacheKey);
    const now = Date.now();
    const bypassCache = shouldBypassCache(req.query.cache);

    if (!bypassCache && cached && now - cached.fetchedAt < CONTRACT_STATE_CACHE_TTL_MS) {
      return res.json(withCacheMetadata(cached.state, "cached", cached.fetchedAt));
    }

    const state = await readContractState(contractId, tokenId);
    contractStateCache.set(cacheKey, { state, fetchedAt: now });
    res.json(withCacheMetadata(state, "live", now));
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

contractRouter.get("/info", async (req, res, next) => {
  try {
    const stateRequest = resolveStateRequest(req, res);
    if (!stateRequest) return;

    const { contractId, tokenId } = stateRequest;
    const state = await readContractState(contractId, tokenId);
    const info = { ...state };
    delete info.networkPassphrase;
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
    const dummyAccount = new Account(
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      "0"
    );
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
    const balance = retval?.i128()
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
contractRouter.get("/collaborator-count/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const contract = new Contract(contractId);
    const dummyAccount = new Account(
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
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

    const count = sim.result?.retval?.u32() ?? 0;
    res.json({ contractId, count });
  } catch (err) {
    next(err);
  }
});

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
        "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
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
      const totalShares = resultVal?.u32() ?? 0;

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
contractRouter.get(
  "/version/:contractId",
  validateContractIdMiddleware,
  async (req, res, next) => {
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
  },
);
