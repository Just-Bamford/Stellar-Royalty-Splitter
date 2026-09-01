import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

/**
 * Fetches contract performance data across all contracts.
 * Query key: ["contractPerformance", dateRange]
 */
export function useContractPerformance(
  dateRange?: { start: string; end: string },
  options?: { sortBy?: string; direction?: string; limit?: number },
) {
  return useQuery({
    queryKey: ["contractPerformance", dateRange],
    queryFn: () => api.getContractPerformance(dateRange, options),
  });
}
