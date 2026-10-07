/**
 * Lens Protocol v2 integration service.
 *
 * Fetches public profile data from the Lens Protocol GraphQL API.
 * No API key required for read-only public profile queries.
 *
 * Caching: results are stored in a simple Map with a TTL of 5 minutes so
 * repeated requests for the same address within one server process don't
 * hammer the Lens API. Cache is intentionally in-process (no Redis) to keep
 * the dependency footprint zero.
 *
 * Error handling: every exported function returns null on any failure — the
 * caller never has to handle thrown errors from this module.
 */

import logger from "../logger.js";

const LENS_API_URL = process.env.LENS_API_URL ?? "https://api-v2.lens.dev";
const FETCH_TIMEOUT_MS = 400;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Cache ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, { profile: LensProfileResult|null, expiresAt: number }>} */
const cache = new Map();

function getCached(address) {
  const entry = cache.get(address);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(address);
    return undefined;
  }
  return entry.profile;
}

function setCache(address, profile) {
  cache.set(address, { profile, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Clear the cache — exported for testing. */
export function clearLensCache() {
  cache.clear();
}

// ── GraphQL query ─────────────────────────────────────────────────────────────

const PROFILE_QUERY = `
  query ProfilesByAddress($address: EvmAddress!) {
    profilesManaged(request: { for: $address }) {
      items {
        id
        handle {
          fullHandle
          localName
        }
        metadata {
          displayName
          bio
          picture {
            ... on ImageSet {
              optimized {
                uri
              }
              raw {
                uri
              }
            }
            ... on NftImage {
              image {
                optimized {
                  uri
                }
                raw {
                  uri
                }
              }
            }
          }
        }
        stats {
          followers
          following
        }
      }
    }
  }
`;

// ── Fetch helper ──────────────────────────────────────────────────────────────

async function fetchLensProfile(address) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(LENS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: PROFILE_QUERY,
        variables: { address },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      logger.warn("Lens API returned non-OK status", {
        status: res.status,
        address,
      });
      return null;
    }

    const json = await res.json();

    if (json.errors?.length) {
      logger.warn("Lens API returned GraphQL errors", {
        errors: json.errors,
        address,
      });
      return null;
    }

    const items = json?.data?.profilesManaged?.items ?? [];
    if (items.length === 0) return null;

    // Use the first (primary) profile
    const profile = items[0];
    const metadata = profile.metadata ?? {};
    const stats = profile.stats ?? {};

    // Resolve avatar: prefer optimized ImageSet, fall back to raw, then NftImage
    let picture = null;
    if (metadata.picture) {
      const p = metadata.picture;
      picture =
        p.optimized?.uri ??
        p.raw?.uri ??
        p.image?.optimized?.uri ??
        p.image?.raw?.uri ??
        null;
    }

    return {
      handle: profile.handle?.fullHandle ?? profile.handle?.localName ?? null,
      displayName: metadata.displayName ?? null,
      picture,
      followers: stats.followers ?? 0,
      following: stats.following ?? 0,
      bio: metadata.bio ?? null,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      logger.warn("Lens API request timed out", { address, timeoutMs: FETCH_TIMEOUT_MS });
    } else {
      logger.warn("Lens API fetch error", { address, error: err?.message });
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch Lens Protocol profile for an Ethereum address.
 * Returns null if the address has no profile or on any error.
 *
 * @param {string} address  Ethereum address (0x…)
 * @returns {Promise<{
 *   handle: string,
 *   displayName: string|null,
 *   picture: string|null,
 *   followers: number,
 *   following: number,
 *   bio: string|null
 * }|null>}
 */
export async function getLensProfile(address) {
  if (!address || typeof address !== "string") return null;

  const cached = getCached(address);
  if (cached !== undefined) return cached;

  const profile = await fetchLensProfile(address);
  setCache(address, profile);
  return profile;
}

/**
 * Batch-fetch Lens profiles for multiple addresses.
 * Returns an object keyed by address; missing profiles have null values.
 *
 * @param {string[]} addresses
 * @returns {Promise<Record<string, object|null>>}
 */
export async function getLensProfiles(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) return {};

  const results = await Promise.all(
    addresses.map(async (addr) => [addr, await getLensProfile(addr)]),
  );

  return Object.fromEntries(results);
}

export const _config = { LENS_API_URL, FETCH_TIMEOUT_MS, CACHE_TTL_MS };
