import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

/**
 * Fetches the current system health status.
 * Query key: ["health"]
 *
 * `refetchInterval: 30_000` replaces the manual `setInterval(fetchAll, 30_000)`
 * that was in HealthDashboard.tsx (#832).
 */
export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api.getHealth(),
    refetchInterval: 30_000,
  });
}

/**
 * Fetches historical health snapshots for the given number of past hours.
 * Query key: ["healthHistory", hours]
 */
export function useHealthHistory(hours: number = 24) {
  return useQuery({
    queryKey: ["healthHistory", hours],
    queryFn: () => api.getHealthHistory(hours),
    refetchInterval: 30_000,
  });
}

/**
 * Fetches SLA statistics for the given number of past days.
 * Query key: ["healthSla", days]
 */
export function useHealthSla(days: number = 30) {
  return useQuery({
    queryKey: ["healthSla", days],
    queryFn: () => api.getHealthSla(days),
    refetchInterval: 30_000,
  });
}
