import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

/**
 * Fetches a paginated list of secondary (NFT resale) sales for a contract.
 * Query key: ["secondarySales", contractId, limit, offset, nftId]
 */
export function useSecondarySales(
  contractId: string | undefined,
  limit: number,
  offset: number,
  nftId?: string,
) {
  return useQuery({
    queryKey: ["secondarySales", contractId, limit, offset, nftId],
    queryFn: () => api.getSecondarySales(contractId!, limit, offset, nftId),
    enabled: !!contractId,
    placeholderData: (prev) => prev,
  });
}

/**
 * Fetches a paginated list of secondary royalty distribution records.
 * Query key: ["secondaryDistributions", contractId, limit, offset]
 */
export function useSecondaryDistributions(
  contractId: string | undefined,
  limit: number,
  offset: number,
) {
  return useQuery({
    queryKey: ["secondaryDistributions", contractId, limit, offset],
    queryFn: () => api.getSecondaryRoyaltyDistributions(contractId!, limit, offset),
    enabled: !!contractId,
    placeholderData: (prev) => prev,
  });
}
