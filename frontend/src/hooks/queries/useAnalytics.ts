import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

/**
 * Fetches contract analytics for a given contract ID and optional date range.
 * Query key: ["analytics", contractId, dateRange]
 *
 * Deduplicates concurrent requests from Dashboard and CollaboratorTable that
 * both previously called api.getAnalytics independently (#832).
 */
export function useAnalytics(
  contractId: string | undefined,
  dateRange?: { start: string; end: string },
) {
  return useQuery({
    queryKey: ["analytics", contractId, dateRange],
    queryFn: () => api.getAnalytics(contractId!, dateRange),
    enabled: !!contractId,
  });
}
