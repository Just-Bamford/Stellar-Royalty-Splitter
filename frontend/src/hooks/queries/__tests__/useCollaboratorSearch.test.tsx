/**
 * Tests for the useCollaboratorSearch hook (#923).
 *
 * Covers: data fetching/merging (tiers + analytics + statuses onto the base
 * collaborator list), and the pure `filterAndSortCollaborators` search /
 * filter / sort logic in isolation (search, tier, status, earnings range,
 * join-date range, combined AND semantics, and each sort key/direction).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("../../../api", () => ({
  api: {
    getCollaborators: vi.fn(),
    getContractTiers: vi.fn(),
    getAnalytics: vi.fn(),
    getContributorStatuses: vi.fn(),
  },
}));

import { api } from "../../../api";
import {
  useCollaboratorSearch,
  filterAndSortCollaborators,
  type CollaboratorSearchItem,
} from "../useCollaboratorSearch";

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
}

const ADDR_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ADDR_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ADDR_C = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

describe("useCollaboratorSearch — data fetching", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = makeQueryClient();
    vi.mocked(api.getCollaborators).mockResolvedValue([
      { address: ADDR_A, basisPoints: 7000 },
      { address: ADDR_B, basisPoints: 3000 },
    ]);
    vi.mocked(api.getContractTiers).mockResolvedValue({
      success: true,
      data: [{ walletAddress: ADDR_A, tier: "vip" }],
      validTiers: ["vip", "regular", "trial"],
    });
    vi.mocked(api.getAnalytics).mockResolvedValue({
      success: true,
      data: {
        totalDistributed: 0,
        totalTransactions: 0,
        averagePayout: 0,
        primaryRoyaltiesTotal: 0,
        secondaryRoyaltiesTotal: 0,
        topEarners: [],
        distributionTrends: [],
        collaboratorStats: [
          { address: ADDR_A, totalEarned: 500, payoutCount: 3, firstActivity: "2024-01-01", lastActivity: "2024-06-01" },
        ],
      },
    });
    vi.mocked(api.getContributorStatuses).mockResolvedValue({
      success: true,
      data: [{ contractId: "c1", address: ADDR_B, status: "suspended", reason: null, suspendedAt: null, deactivatedAt: null, updatedBy: null }],
    });
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("merges collaborators with tier, status, and earnings data", async () => {
    const { result } = renderHook(() => useCollaboratorSearch("c1"), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.all).toHaveLength(2);
    const a = result.current.all.find((c) => c.address === ADDR_A)!;
    expect(a.tier).toBe("vip");
    expect(a.totalEarned).toBe(500);
    expect(a.payoutCount).toBe(3);

    const b = result.current.all.find((c) => c.address === ADDR_B)!;
    expect(b.tier).toBe("regular"); // default when no tier record
    expect(b.status).toBe("suspended");
  });

  it("does not fetch when contractId is undefined", () => {
    const { result } = renderHook(() => useCollaboratorSearch(undefined), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current.isFetching).toBe(false);
    expect(api.getCollaborators).not.toHaveBeenCalled();
  });

  it("falls back gracefully when tiers/analytics/statuses calls fail", async () => {
    vi.mocked(api.getContractTiers).mockRejectedValue(new Error("no tiers"));
    vi.mocked(api.getAnalytics).mockRejectedValue(new Error("no analytics"));
    vi.mocked(api.getContributorStatuses).mockRejectedValue(new Error("no statuses"));

    const { result } = renderHook(() => useCollaboratorSearch("c1"), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.all).toHaveLength(2);
    expect(result.current.all[0].tier).toBe("regular");
    expect(result.current.all[0].status).toBe("active");
    expect(result.current.all[0].totalEarned).toBe(0);
  });
});

describe("filterAndSortCollaborators — pure search/filter/sort logic", () => {
  const items: CollaboratorSearchItem[] = [
    {
      address: ADDR_A,
      basisPoints: 7000,
      sharePercentage: 70,
      name: "Alice",
      tier: "vip",
      status: "active",
      totalEarned: 1000,
      payoutCount: 5,
      joinDate: "2024-01-01T00:00:00.000Z",
      lastActivity: "2024-06-01T00:00:00.000Z",
    },
    {
      address: ADDR_B,
      basisPoints: 2000,
      sharePercentage: 20,
      tier: "regular",
      status: "suspended",
      totalEarned: 300,
      payoutCount: 2,
      joinDate: "2024-03-01T00:00:00.000Z",
      lastActivity: "2024-05-01T00:00:00.000Z",
    },
    {
      address: ADDR_C,
      basisPoints: 1000,
      sharePercentage: 10,
      tier: "trial",
      status: "active",
      totalEarned: 50,
      payoutCount: 0,
      joinDate: null,
      lastActivity: null,
    },
  ];

  it("returns all items with no filters", () => {
    expect(filterAndSortCollaborators(items, {})).toHaveLength(3);
  });

  it("searches by name", () => {
    const result = filterAndSortCollaborators(items, { search: "alice" });
    expect(result.map((r) => r.address)).toEqual([ADDR_A]);
  });

  it("searches by address substring", () => {
    const result = filterAndSortCollaborators(items, { search: "GBBB" });
    expect(result.map((r) => r.address)).toEqual([ADDR_B]);
  });

  it("searches by tier", () => {
    const result = filterAndSortCollaborators(items, { search: "trial" });
    expect(result.map((r) => r.address)).toEqual([ADDR_C]);
  });

  it("filters by tier", () => {
    const result = filterAndSortCollaborators(items, { tier: "vip" });
    expect(result.map((r) => r.address)).toEqual([ADDR_A]);
  });

  it("filters by status", () => {
    const result = filterAndSortCollaborators(items, { status: "suspended" });
    expect(result.map((r) => r.address)).toEqual([ADDR_B]);
  });

  it("filters by earnings range", () => {
    const result = filterAndSortCollaborators(items, { minEarnings: 100, maxEarnings: 500 });
    expect(result.map((r) => r.address)).toEqual([ADDR_B]);
  });

  it("filters by join date range, excluding items with no known join date", () => {
    const result = filterAndSortCollaborators(items, {
      joinedAfter: "2024-02-01",
      joinedBefore: "2024-12-31",
    });
    expect(result.map((r) => r.address)).toEqual([ADDR_B]);
  });

  it("combines tier + status + earnings filters with AND semantics", () => {
    // vip AND active AND earnings >= 500 -> only Alice qualifies
    const result = filterAndSortCollaborators(items, {
      tier: "vip",
      status: "active",
      minEarnings: 500,
    });
    expect(result.map((r) => r.address)).toEqual([ADDR_A]);

    // vip AND suspended -> nobody (Alice is vip but active, not suspended)
    const none = filterAndSortCollaborators(items, { tier: "vip", status: "suspended" });
    expect(none).toHaveLength(0);
  });

  it("sorts by earnings descending by default direction", () => {
    const result = filterAndSortCollaborators(items, { sortBy: "earnings", sortDirection: "desc" });
    expect(result.map((r) => r.address)).toEqual([ADDR_A, ADDR_B, ADDR_C]);
  });

  it("sorts by earnings ascending", () => {
    const result = filterAndSortCollaborators(items, { sortBy: "earnings", sortDirection: "asc" });
    expect(result.map((r) => r.address)).toEqual([ADDR_C, ADDR_B, ADDR_A]);
  });

  it("sorts by join date, treating null as earliest", () => {
    const result = filterAndSortCollaborators(items, { sortBy: "joinDate", sortDirection: "asc" });
    expect(result.map((r) => r.address)).toEqual([ADDR_C, ADDR_A, ADDR_B]);
  });

  it("sorts by activity", () => {
    const result = filterAndSortCollaborators(items, { sortBy: "activity", sortDirection: "desc" });
    expect(result.map((r) => r.address)).toEqual([ADDR_A, ADDR_B, ADDR_C]);
  });

  it("sorts by address alphabetically", () => {
    const result = filterAndSortCollaborators(items, { sortBy: "address", sortDirection: "asc" });
    expect(result.map((r) => r.address)).toEqual([ADDR_A, ADDR_B, ADDR_C]);
  });

  it("sorts by share", () => {
    const result = filterAndSortCollaborators(items, { sortBy: "share", sortDirection: "desc" });
    expect(result.map((r) => r.address)).toEqual([ADDR_A, ADDR_B, ADDR_C]);
  });

  it("returns an empty array when nothing matches", () => {
    const result = filterAndSortCollaborators(items, { search: "ZZZ_NO_MATCH" });
    expect(result).toHaveLength(0);
  });

  it("handles an empty input list", () => {
    expect(filterAndSortCollaborators([], { search: "anything" })).toEqual([]);
  });
});
