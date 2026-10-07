import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

/**
 * Advanced collaborator search/filter/sort hook (#923).
 *
 * Scoping decision: the backend's `GET /collaborators/:contractId` endpoint
 * (backend/src/routes/collaborators.js) only returns the contract's raw
 * `{ address, basisPoints }[]` list straight from `get_all_shares` — there
 * is no dedicated search/filter/sort endpoint, and adding backend bulk
 * operation endpoints is explicitly out of scope for issue #923 ("assume
 * existing routes can handle it"). So this hook fetches the existing full
 * collaborator list (plus tier and earnings/status data from the existing
 * tiers/analytics endpoints, same as `CollaboratorTable.tsx` already does)
 * and performs search, filtering, and sorting entirely client-side. This is
 * an explicit, accepted scoping decision, not an oversight — for the
 * "100+ collaborators" scale named in the issue, client-side filtering of
 * a single already-fetched array is cheap and avoids a network round trip
 * per keystroke.
 */

export interface CollaboratorSearchItem {
  address: string;
  basisPoints: number;
  sharePercentage: number;
  name?: string;
  tier: "vip" | "regular" | "trial";
  status: "active" | "suspended" | "deactivated";
  totalEarned: number;
  payoutCount: number;
  joinDate: string | null;
  lastActivity: string | null;
}

export type CollaboratorSortKey =
  | "earnings"
  | "joinDate"
  | "activity"
  | "address"
  | "share";

export type CollaboratorSortDirection = "asc" | "desc";

export interface CollaboratorSearchFilters {
  /** Matches against address, saved name, or tier label (case-insensitive substring). */
  search?: string;
  tier?: "all" | "vip" | "regular" | "trial";
  status?: "all" | "active" | "suspended" | "deactivated";
  minEarnings?: number;
  maxEarnings?: number;
  joinedAfter?: string; // ISO date
  joinedBefore?: string; // ISO date
  sortBy?: CollaboratorSortKey;
  sortDirection?: CollaboratorSortDirection;
}

const DEFAULT_FILTERS: Required<
  Pick<CollaboratorSearchFilters, "tier" | "status" | "sortBy" | "sortDirection">
> = {
  tier: "all",
  status: "all",
  sortBy: "earnings",
  sortDirection: "desc",
};

/**
 * Fetches collaborators + tiers + analytics for a contract and merges them
 * into a single denormalized list. Kept separate from the filtering logic
 * below so the two concerns (fetching vs. deriving) can be tested/reasoned
 * about independently.
 */
export function useCollaboratorDirectoryData(contractId: string | undefined) {
  return useQuery({
    queryKey: ["collaborator-directory", contractId],
    queryFn: async (): Promise<CollaboratorSearchItem[]> => {
      const [collaborators, tiersRes, analyticsRes, statusesRes] = await Promise.all([
        api.getCollaborators(contractId!),
        api.getContractTiers(contractId!).catch(() => ({ success: false, data: [], validTiers: [] })),
        api.getAnalytics(contractId!).catch(() => null),
        api.getContributorStatuses(contractId!, true).catch(() => ({ success: false, data: [] })),
      ]);

      const tierMap = new Map<string, "vip" | "regular" | "trial">();
      for (const t of tiersRes.data ?? []) {
        tierMap.set(t.walletAddress, t.tier);
      }

      const statusMap = new Map<string, "active" | "suspended" | "deactivated">();
      for (const s of statusesRes.data ?? []) {
        statusMap.set(s.address, s.status);
      }

      const statsMap = new Map<
        string,
        { totalEarned: number; payoutCount: number; firstActivity?: string | null; lastActivity?: string | null }
      >();
      if (analyticsRes?.success) {
        for (const stat of analyticsRes.data.collaboratorStats ?? []) {
          statsMap.set(stat.address, stat);
        }
      }

      return collaborators.map((c) => {
        const stats = statsMap.get(c.address);
        return {
          address: c.address,
          basisPoints: c.basisPoints,
          sharePercentage: +(c.basisPoints / 100).toFixed(2),
          tier: tierMap.get(c.address) ?? "regular",
          status: statusMap.get(c.address) ?? "active",
          totalEarned: stats?.totalEarned ?? 0,
          payoutCount: stats?.payoutCount ?? 0,
          joinDate: stats?.firstActivity ?? null,
          lastActivity: stats?.lastActivity ?? null,
        };
      });
    },
    enabled: !!contractId,
  });
}

/**
 * Pure client-side search/filter/sort over an already-fetched collaborator
 * list. Filters combine with AND semantics: a collaborator must satisfy
 * every active filter (search AND tier AND status AND earnings-range AND
 * join-date-range) to be included.
 */
export function filterAndSortCollaborators(
  items: CollaboratorSearchItem[],
  filters: CollaboratorSearchFilters,
): CollaboratorSearchItem[] {
  const search = filters.search?.trim().toLowerCase() ?? "";
  const tier = filters.tier ?? DEFAULT_FILTERS.tier;
  const status = filters.status ?? DEFAULT_FILTERS.status;
  const sortBy = filters.sortBy ?? DEFAULT_FILTERS.sortBy;
  const sortDirection = filters.sortDirection ?? DEFAULT_FILTERS.sortDirection;

  const filtered = items.filter((item) => {
    if (search) {
      const matchesAddress = item.address.toLowerCase().includes(search);
      const matchesName = item.name ? item.name.toLowerCase().includes(search) : false;
      const matchesTier = item.tier.toLowerCase().includes(search);
      if (!matchesAddress && !matchesName && !matchesTier) return false;
    }

    if (tier !== "all" && item.tier !== tier) return false;
    if (status !== "all" && item.status !== status) return false;

    if (filters.minEarnings !== undefined && item.totalEarned < filters.minEarnings) {
      return false;
    }
    if (filters.maxEarnings !== undefined && item.totalEarned > filters.maxEarnings) {
      return false;
    }

    if (filters.joinedAfter && item.joinDate) {
      if (new Date(item.joinDate).getTime() < new Date(filters.joinedAfter).getTime()) {
        return false;
      }
    }
    if (filters.joinedBefore && item.joinDate) {
      if (new Date(item.joinDate).getTime() > new Date(filters.joinedBefore).getTime()) {
        return false;
      }
    }
    // If a join-date filter is active but the collaborator has no known
    // join date, exclude it — we can't confirm it satisfies the range.
    if ((filters.joinedAfter || filters.joinedBefore) && !item.joinDate) {
      return false;
    }

    return true;
  });

  const dir = sortDirection === "asc" ? 1 : -1;
  filtered.sort((a, b) => {
    switch (sortBy) {
      case "earnings":
        return (a.totalEarned - b.totalEarned) * dir;
      case "joinDate": {
        const aTime = a.joinDate ? new Date(a.joinDate).getTime() : 0;
        const bTime = b.joinDate ? new Date(b.joinDate).getTime() : 0;
        return (aTime - bTime) * dir;
      }
      case "activity": {
        const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
        const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
        return (aTime - bTime) * dir;
      }
      case "address":
        return a.address.localeCompare(b.address) * dir;
      case "share":
        return (a.basisPoints - b.basisPoints) * dir;
      default:
        return 0;
    }
  });

  return filtered;
}

/**
 * Combined hook: fetches directory data (React Query, cached under
 * `["collaborator-directory", contractId]`) and derives the filtered/sorted
 * list via `useMemo` so filtering never re-fetches from the network.
 */
export function useCollaboratorSearch(
  contractId: string | undefined,
  filters: CollaboratorSearchFilters = {},
) {
  const query = useCollaboratorDirectoryData(contractId);

  const results = useMemo(
    () => filterAndSortCollaborators(query.data ?? [], filters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      query.data,
      filters.search,
      filters.tier,
      filters.status,
      filters.minEarnings,
      filters.maxEarnings,
      filters.joinedAfter,
      filters.joinedBefore,
      filters.sortBy,
      filters.sortDirection,
    ],
  );

  return {
    ...query,
    all: query.data ?? [],
    results,
  };
}
