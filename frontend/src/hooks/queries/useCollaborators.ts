import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

/**
 * Fetches the list of collaborators (address + basisPoints) for a contract.
 * Query key: ["collaborators", contractId]
 */
export function useCollaborators(contractId: string | undefined) {
  return useQuery({
    queryKey: ["collaborators", contractId],
    queryFn: () => api.getCollaborators(contractId!),
    enabled: !!contractId,
  });
}
