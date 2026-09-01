import { QueryClient } from "@tanstack/react-query";

/**
 * Shared React Query client (#832).
 *
 * Defaults:
 * - staleTime 30 s  — data is "fresh" for 30 seconds; no refetch within that window
 * - gcTime   5 min  — unused cache entries survive for 5 minutes before GC
 * - refetchOnWindowFocus true  — re-validates stale data when the user returns to the tab
 * - retry 1         — one automatic retry before surfacing an error to the UI
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});
