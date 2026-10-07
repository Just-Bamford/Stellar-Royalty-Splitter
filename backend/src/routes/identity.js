/**
 * Identity proxy routes — ENS resolution and Lens Protocol profile fetch.
 *
 * These routes act as a server-side proxy so the frontend avoids CORS issues
 * and we can cache results centrally (Lens service has its own TTL cache).
 *
 * Endpoints:
 *   GET /api/v1/identity/ens/:address   — resolve ENS name + avatar for address
 *   GET /api/v1/identity/lens/:address  — fetch Lens Protocol profile for address
 */

import { Router } from "express";
import { getLensProfile } from "../services/lens-protocol.js";
import { sendError } from "../error-response.js";
import logger from "../logger.js";

export const identityRouter = Router();

// ── ENS constants ─────────────────────────────────────────────────────────────

const ENS_SUBGRAPH_URL =
  process.env.ENS_SUBGRAPH_URL ??
  "https://api.thegraph.com/subgraphs/name/ensdomains/ens";

const ENS_TIMEOUT_MS = 400;

/** Simple in-process ENS cache with 5-min TTL */
const ensCache = new Map();
const ENS_CACHE_TTL_MS = 5 * 60 * 1000;

function getEnsCached(address) {
  const entry = ensCache.get(address);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    ensCache.delete(address);
    return undefined;
  }
  return entry.result;
}

function setEnsCache(address, result) {
  ensCache.set(address, { result, expiresAt: Date.now() + ENS_CACHE_TTL_MS });
}

// ── ENS resolution ────────────────────────────────────────────────────────────

async function resolveEnsForAddress(address) {
  const query = `{
    domains(where: { resolvedAddress: "${address.toLowerCase()}" }, first: 1, orderBy: createdAt, orderDirection: desc) {
      name
      resolver {
        texts(first: 5)
      }
    }
  }`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENS_TIMEOUT_MS);

  try {
    const res = await fetch(ENS_SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const json = await res.json();
    const domains = json?.data?.domains ?? [];
    if (domains.length === 0) return null;

    const domain = domains[0];
    const name = domain.name ?? null;
    if (!name) return null;

    // Attempt to fetch the avatar text record via a second subgraph call
    let avatar = null;
    const avatarQuery = `{
      resolver(id: "${address.toLowerCase()}") {
        texts
      }
    }`;

    // Best-effort avatar fetch — ignore on any error
    try {
      const avatarRes = await fetch(ENS_SUBGRAPH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: avatarQuery }),
        signal: controller.signal,
      });
      if (avatarRes.ok) {
        const avatarJson = await avatarRes.json();
        const texts = avatarJson?.data?.resolver?.texts ?? [];
        if (texts.includes("avatar")) {
          // The actual avatar value requires a separate eth_call; we return
          // a deterministic Gravatar-style fallback URL instead so the UI
          // always has something to show.
          avatar = `https://metadata.ens.domains/mainnet/avatar/${name}`;
        }
      }
    } catch {
      // avatar stays null — not fatal
    }

    return { name, avatar, verified: true };
  } catch (err) {
    if (err?.name === "AbortError") {
      logger.warn("ENS subgraph request timed out", { address });
    } else {
      logger.warn("ENS subgraph fetch error", { address, error: err?.message });
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/identity/ens/:address
 *
 * Resolves ENS name and avatar for the given Ethereum address.
 * Returns 404 when the address has no ENS name.
 */
identityRouter.get("/ens/:address", async (req, res, next) => {
  const { address } = req.params;

  if (!address || typeof address !== "string" || address.length < 10) {
    return sendError(res, 400, "invalid_address", "A valid address is required");
  }

  try {
    const cached = getEnsCached(address);
    if (cached !== undefined) {
      if (cached === null) {
        return sendError(res, 404, "not_found", "No ENS name found for this address");
      }
      return res.json(cached);
    }

    const result = await resolveEnsForAddress(address);
    setEnsCache(address, result);

    if (!result) {
      return sendError(res, 404, "not_found", "No ENS name found for this address");
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/identity/lens/:address
 *
 * Fetches Lens Protocol profile for the given address.
 * Returns 404 when the address has no Lens profile.
 */
identityRouter.get("/lens/:address", async (req, res, next) => {
  const { address } = req.params;

  if (!address || typeof address !== "string" || address.length < 10) {
    return sendError(res, 400, "invalid_address", "A valid address is required");
  }

  try {
    const profile = await getLensProfile(address);

    if (!profile) {
      return sendError(res, 404, "not_found", "No Lens profile found for this address");
    }

    res.json(profile);
  } catch (err) {
    next(err);
  }
});
