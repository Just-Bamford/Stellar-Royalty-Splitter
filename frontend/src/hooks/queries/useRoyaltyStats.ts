import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

/**
 * Fetches secondary royalty stats (total sales, royalties generated, last distribution).
 * Query key: ["royaltyStats", contractId]
 */
export function useRoyaltyStats(contractId: string | undefined) {
  return useQuery({
    queryKey: ["royaltyStats", contractId],
    queryFn: () => api.getRoyaltyStats(contractId!),
    enabled: !!contractId,
  });
}
