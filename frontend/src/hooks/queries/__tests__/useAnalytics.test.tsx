/**
 * Tests for useAnalytics React Query hook (#832).
 *
 * Key behaviors verified:
 * 1. Returns data from the API on success.
 * 2. Deduplicates concurrent requests with the same query key — two hooks
 *    mounted with the same contractId fire only one network call.
 * 3. Serves cached data on subsequent renders without a network call.
 * 4. Respects the `enabled: !!contractId` guard — no fetch when contractId is
 *    empty / undefined.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Bypass the global mock added in setup.ts so we exercise the real hook (#832).
vi.unmock("../useAnalytics");
import { useAnalytics } from "../useAnalytics";

// ── Mock the api module ──────────────────────────────────────────────────────

vi.mock("../../../api", () => ({
  api: {
    getAnalytics: vi.fn(),
  },
}));

import { api } from "../../../api";

const MOCK_ANALYTICS = {
  success: true,
  data: {
    totalDistributed: 1000,
    totalTransactions: 10,
    averagePayout: 100,
    primaryRoyaltiesTotal: 800,
    secondaryRoyaltiesTotal: 200,
    topEarners: [],
    distributionTrends: [],
    collaboratorStats: [],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 30_000,
      },
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useAnalytics", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = makeQueryClient();
    vi.mocked(api.getAnalytics).mockResolvedValue(MOCK_ANALYTICS);
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("returns analytics data when contractId is provided", async () => {
    const { result } = renderHook(
      () => useAnalytics("CONTRACT_A"),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(MOCK_ANALYTICS);
    expect(api.getAnalytics).toHaveBeenCalledTimes(1);
    expect(api.getAnalytics).toHaveBeenCalledWith("CONTRACT_A", undefined);
  });

  it("does NOT fetch when contractId is undefined", async () => {
    const { result } = renderHook(
      () => useAnalytics(undefined),
      { wrapper: createWrapper(queryClient) },
    );

    // Query is disabled — stays in pending state without firing
    expect(result.current.isPending).toBe(true);
    expect(result.current.isFetching).toBe(false);
    expect(api.getAnalytics).not.toHaveBeenCalled();
  });

  it("does NOT fetch when contractId is an empty string", async () => {
    const { result } = renderHook(
      () => useAnalytics(""),
      { wrapper: createWrapper(queryClient) },
    );

    expect(result.current.isFetching).toBe(false);
    expect(api.getAnalytics).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent requests with the same contractId", async () => {
    const wrapper = createWrapper(queryClient);

    // Mount two hooks with the same contractId simultaneously
    const { result: result1 } = renderHook(
      () => useAnalytics("CONTRACT_B"),
      { wrapper },
    );
    const { result: result2 } = renderHook(
      () => useAnalytics("CONTRACT_B"),
      { wrapper },
    );

    await waitFor(() => expect(result1.current.isSuccess).toBe(true));
    await waitFor(() => expect(result2.current.isSuccess).toBe(true));

    // Only one network call despite two concurrent subscribers
    expect(api.getAnalytics).toHaveBeenCalledTimes(1);

    // Both hooks return the same data
    expect(result1.current.data).toEqual(MOCK_ANALYTICS);
    expect(result2.current.data).toEqual(MOCK_ANALYTICS);
  });

  it("serves cached data on re-render without a new network call", async () => {
    const wrapper = createWrapper(queryClient);

    const { result, rerender } = renderHook(
      () => useAnalytics("CONTRACT_C"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.getAnalytics).toHaveBeenCalledTimes(1);

    // Re-render within staleTime — should NOT trigger a second fetch
    rerender();
    expect(api.getAnalytics).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(MOCK_ANALYTICS);
  });

  it("passes dateRange to the API call when provided", async () => {
    const dateRange = { start: "2025-01-01", end: "2025-12-31" };

    const { result } = renderHook(
      () => useAnalytics("CONTRACT_D", dateRange),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.getAnalytics).toHaveBeenCalledWith("CONTRACT_D", dateRange);
  });
});
