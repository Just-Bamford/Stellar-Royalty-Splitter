/**
 * Client-side mirror of the contract's `is_collaborator(addr) -> bool`
 * entrypoint (#746).
 *
 * The frontend already fetches the full collaborator list in one call
 * (`api.getCollaborators`, backed by the contract's `get_all_shares` —
 * see backend/src/routes/collaborators.js), so a membership check against
 * data already in memory never needs its own RPC round trip. This helper
 * exists so call sites don't each reimplement the same `.some(...)` /
 * `.find(...)` address comparison, and so the comparison semantics (exact,
 * case-sensitive match — Stellar addresses are case-sensitive base32) stay
 * consistent everywhere a component needs to answer "is this address a
 * registered collaborator?".
 */

export interface CollaboratorLike {
  address: string;
}

/**
 * Returns true if `address` matches a collaborator in `collaborators`.
 *
 * Mirrors the contract's `is_collaborator`: a `null`/`undefined`/empty
 * address never matches, and comparison is an exact string match (no
 * normalization — Stellar addresses are already canonical base32 strings).
 */
export function isCollaborator(
  collaborators: CollaboratorLike[] | null | undefined,
  address: string | null | undefined,
): boolean {
  if (!address || !collaborators || collaborators.length === 0) {
    return false;
  }
  return collaborators.some((c) => c.address === address);
}

/**
 * Returns the collaborator entry matching `address`, or `undefined` if
 * `address` is not a registered collaborator. Useful when the caller also
 * needs the matched collaborator's other fields (e.g. basisPoints) rather
 * than just a boolean.
 */
export function findCollaborator<T extends CollaboratorLike>(
  collaborators: T[] | null | undefined,
  address: string | null | undefined,
): T | undefined {
  if (!address || !collaborators || collaborators.length === 0) {
    return undefined;
  }
  return collaborators.find((c) => c.address === address);
}
