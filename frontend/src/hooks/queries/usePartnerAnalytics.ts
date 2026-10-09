import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

/**
 * Fetches the partner analytics dashboard payload — calls over time, top
 * endpoints, error rates and revenue per partner (#996).
 * Query key: ["partner-analytics", days, partnerId]
 *
 * `partnerId` is optional; omit it to see the platform-wide view.
 */
export function usePartnerAnalytics(days = 30, partnerId?: string) {
  return useQuery({
    queryKey: ["partner-analytics", days, partnerId ?? null],
    queryFn: () => api.getPartnerAnalytics(partnerId || "platform"),
    enabled: days > 0,
  });
}
