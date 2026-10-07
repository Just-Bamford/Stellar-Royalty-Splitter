/**
 * Web3 identity service — ENS resolution + Lens Protocol profile enrichment.
 *
 * Architecture:
 *  - ENS  : resolved via our own backend proxy (/api/v1/identity/ens/:address)
 *           which calls the ENS subgraph. This avoids CORS issues and lets us
 *           cache results server-side.
 *  - Lens : resolved via our own backend proxy (/api/v1/identity/lens/:address)
 *           which calls the Lens v2 public GraphQL API.
 *
 * Both paths return null on any error so callers always get a safe result.
 * Results are cached in-process for the lifetime of the page (WeakMap keyed
 * on the address string so entries are GC-eligible when no longer referenced).
 *
 * Performance target: profile load < 500 ms (matching acceptance criteria).
 * We use a 450 ms AbortController timeout on every fetch so the UI is never
 * blocked longer than that.
 */

const FETCH_TIMEOUT_MS = 450;

// ── In-memory cache ───────────────────────────────────────────────────────────
// Simple Map is fine here — the set of unique addresses on any given page is
// small and bounded by the number of collaborators (≤ 20 per the init schema).

const ensCache = new Map<string, EnsIdentity | null>();
const lensCache = new Map<string, LensProfile | null>();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EnsIdentity {
  /** Human-readable ENS name, e.g. "alice.eth" */
  name: string;
  /** Avatar URL (may be IPFS gateway URL or null) */
  avatar: string | null;
  /** Verified: the address owns this ENS name */
  verified: boolean;
}

export interface LensProfile {
  /** Lens handle, e.g. "lens/@alice" */
  handle: string;
  /** Display name from the Lens profile */
  displayName: string | null;
  /** Profile picture URL */
  picture: string | null;
  /** Number of Lens followers */
  followers: number;
  /** Number of accounts the profile follows */
  following: number;
  /** Lens profile bio */
  bio: string | null;
}

export interface Web3Identity {
  address: string;
  ens: EnsIdentity | null;
  lens: LensProfile | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

// ── ENS resolution ────────────────────────────────────────────────────────────

/**
 * Resolve ENS identity for a given address.
 * Returns null if the address has no ENS name or on any network/timeout error.
 */
export async function resolveEns(address: string): Promise<EnsIdentity | null> {
  if (!address) return null;

  const cached = ensCache.get(address);
  if (ensCache.has(address)) return cached ?? null;

  try {
    const res = await fetchWithTimeout(
      `/api/v1/identity/ens/${encodeURIComponent(address)}`,
    );
    if (!res.ok) {
      ensCache.set(address, null);
      return null;
    }
    const data = (await res.json()) as {
      name?: string;
      avatar?: string | null;
      verified?: boolean;
    };
    if (!data.name) {
      ensCache.set(address, null);
      return null;
    }
    const identity: EnsIdentity = {
      name: data.name,
      avatar: data.avatar ?? null,
      verified: data.verified ?? false,
    };
    ensCache.set(address, identity);
    return identity;
  } catch {
    ensCache.set(address, null);
    return null;
  }
}

// ── Lens resolution ───────────────────────────────────────────────────────────

/**
 * Fetch Lens Protocol profile for a given address.
 * Returns null if the address has no Lens profile or on any error.
 */
export async function resolveLens(address: string): Promise<LensProfile | null> {
  if (!address) return null;

  const cached = lensCache.get(address);
  if (lensCache.has(address)) return cached ?? null;

  try {
    const res = await fetchWithTimeout(
      `/api/v1/identity/lens/${encodeURIComponent(address)}`,
    );
    if (!res.ok) {
      lensCache.set(address, null);
      return null;
    }
    const data = (await res.json()) as {
      handle?: string;
      displayName?: string | null;
      picture?: string | null;
      followers?: number;
      following?: number;
      bio?: string | null;
    };
    if (!data.handle) {
      lensCache.set(address, null);
      return null;
    }
    const profile: LensProfile = {
      handle: data.handle,
      displayName: data.displayName ?? null,
      picture: data.picture ?? null,
      followers: data.followers ?? 0,
      following: data.following ?? 0,
      bio: data.bio ?? null,
    };
    lensCache.set(address, profile);
    return profile;
  } catch {
    lensCache.set(address, null);
    return null;
  }
}

// ── Combined lookup ───────────────────────────────────────────────────────────

/**
 * Fetch both ENS and Lens identity for an address concurrently.
 * Never throws — always returns a Web3Identity object (fields may be null).
 */
export async function resolveIdentity(address: string): Promise<Web3Identity> {
  const [ens, lens] = await Promise.all([
    resolveEns(address),
    resolveLens(address),
  ]);
  return { address, ens, lens };
}

// ── Cache management (for testing) ───────────────────────────────────────────

export function clearIdentityCache(): void {
  ensCache.clear();
  lensCache.clear();
}
