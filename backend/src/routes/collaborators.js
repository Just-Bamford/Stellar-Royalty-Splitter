import { Router } from "express";
import StellarSdk from "@stellar/stellar-sdk";
import { server, networkPassphrase } from "../stellar.js";
import logger from "../logger.js";
import { validateContractIdMiddleware } from "../validation.js";
import { sendError } from "../error-response.js";
import { cacheGet, cacheSet, cacheKey, TTL } from "../cache.js";

const { Address, Contract, SorobanRpc, TransactionBuilder, BASE_FEE, Account } = StellarSdk;
export const collaboratorsRouter = Router();

const LEAD = Number(process.env.CACHE_WARM_LEAD_TIME_MS) || 30000;
const stale = new Map();
const inflight = new Map();
const timers = new Map();
const access = new Map();
let hitCount = 0;
let missCount = 0;
let staleCount = 0;

async function fetch(id) {
  const contract = new Contract(id);
  const dummy = new Account("GAAzI4TCR3TY5OJHCTJ2C4Q4SY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN", "0");
  const tx = new TransactionBuilder(dummy, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call("get_all_shares"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    const e = new Error(sim.error ?? "Simulation failed");
    e.status = 400;
    e.code = "contract_simulation_failed";
    throw e;
  }
  const rv = sim.result?.retval;
  if (!rv) return [];
  return (rv.map()?.entries ?? []).map((e) => ({
    address: Address.fromScVal(e.key()).toString(),
    basisPoints: e.val().u32(),
  }));
}

function schedule(key, id) {
  if (timers.has(key)) clearTimeout(timers.get(key));
  const count = access.get(id) || 1;
  const delay =
    Math.max(TTL.collaborators - LEAD, 1000) / Math.min(count, 5) + Math.random() * 2000;
  const t = setTimeout(() => {
    timers.delete(key);
    refresh(key, id).catch(() => {});
  }, delay);
  timers.set(key, t);
}

async function refresh(key, id) {
  if (inflight.has(key)) return;
  inflight.set(key, true);
  const start = Date.now();
  try {
    const data = await fetch(id);
    cacheSet(key, data, TTL.collaborators);
    stale.set(key, data);
    schedule(key, id);
    logger.info(`[cache] refreshed ${id} in ${Date.now() - start}ms`);
  } catch (e) {
    logger.warn(`[cache] refresh failed for ${id}: ${e.message}`);
  } finally {
    inflight.delete(key);
  }
}

setInterval(() => {
  for (const id of access.keys()) {
    const key = cacheKey("collaborators", id);
    if (!timers.has(key)) schedule(key, id);
  }
}, 60000).unref();

collaboratorsRouter.get("/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const key = cacheKey("collaborators", contractId);
    access.set(contractId, (access.get(contractId) || 0) + 1);

    const cached = cacheGet(key);
    if (cached !== undefined) {
      // hitCount++;
      logger.debug(`[cache] HIT ${contractId}`);
      if (!timers.has(key)) schedule(key, contractId);
      return res.json(cached);
    }

    // missCount++;
    if (stale.has(key)) {
      // staleCount++;
      logger.info(`[cache] STALE ${contractId}`);
      if (!inflight.has(key)) refresh(key, contractId).catch(() => {});
      return res.json(stale.get(key));
    }

    const data = await fetch(contractId);
    const TTL_COLLABORATORS = 300000; // 5 minutes
    cacheSet(key, data, TTL_COLLABORATORS);
    stale.set(key, data);
    schedule(key, contractId);
    logger.info(`get_all_shares returned ${data.length} collaborators for ${contractId}`);
    res.json(data);
  } catch (e) {
    if (e.status === 400) return sendError(res, 400, e.code, e.message);
    next(e);
  }
});
