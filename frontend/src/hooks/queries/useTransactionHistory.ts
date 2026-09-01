import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

type TxFilters = {
  type?: "distribute" | "initialize";
  recipient?: string;
  startDate?: string;
  endDate?: string;
};

/**
 * Fetches a paginated page of transaction history for a contract.
 * Query key: ["txHistory", contractId, limit, offset, filters]
 *
 * Changing `offset` or `filters` produces a distinct cache entry so paginated
 * navigation is also deduplicated and cached.
 */
export function useTransactionHistory(
  contractId: string | undefined,
  limit: number,
  offset: number,
  filters?: TxFilters,
) {
  return useQuery({
    queryKey: ["txHistory", contractId, limit, offset, filters],
    queryFn: () => api.getTransactionHistory(contractId!, limit, offset, filters),
    enabled: !!contractId,
    placeholderData: (prev) => prev, // keep previous page visible while loading next
  });
}
