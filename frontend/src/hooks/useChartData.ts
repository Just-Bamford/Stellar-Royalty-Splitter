import { useMemo, useState, useEffect } from "react";

export type RangeKey = "1W" | "1M" | "3M" | "1Y" | "all";
export type ChartRange = RangeKey; // Alias for backward compatibility

export interface TimePoint {
  date: string;
  value: number;
}

export interface CollaboratorSlice {
  name: string;
  value: number;
}

export interface HeatmapCell {
  day: number;
  hour: number;
  value: number;
}

export interface ChartData {
  earnings: TimePoint[];
  collaborators: CollaboratorSlice[];
  timeSeries: TimePoint[];
  heatmap: HeatmapCell[];
}

export interface UseChartDataResult {
  data: ChartData;
  loading: boolean;
  error: Error | null;
  range: RangeKey;
  setRange: (range: RangeKey) => void;
  refetch: () => void;
}

const RANGE_DAYS: Record<RangeKey, number | null> = {
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "1Y": 365,
  all: null,
};

function dayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function filterByRange(points: TimePoint[], range: RangeKey): TimePoint[] {
  const days = RANGE_DAYS[range];
  if (days === null || points.length === 0) return points;
  const last = new Date(points[points.length - 1].date);
  const cutoff = addDays(last, -(days - 1));
  const cutoffKey = dayKey(cutoff);
  return points.filter((p) => p.date >= cutoffKey);
}

function normalizePoints(raw: any): TimePoint[] {
  if (!Array.isArray(raw)) return [];
  const mapped = raw
    .map((item: any) => {
      const date = item?.date ?? item?.day ?? item?.timestamp;
      const value = Number(item?.value ?? item?.earnings ?? item?.amount ?? 0);
      if (!date) return null;
      const d = new Date(date);
      if (Number.isNaN(d.getTime())) return null;
      return { date: dayKey(d), value: Number.isFinite(value) ? value : 0 };
    })
    .filter((p: any): p is TimePoint => p !== null);

  const bucket = new Map<string, number>();
  for (const p of mapped) {
    bucket.set(p.date, (bucket.get(p.date) ?? 0) + p.value);
  }
  return Array.from(bucket.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function normalizeCollaborators(raw: any): CollaboratorSlice[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item: any) => ({
      name: String(item?.name ?? item?.collaborator ?? item?.id ?? "Unknown"),
      value: Number(item?.value ?? item?.earnings ?? item?.amount ?? 0),
    }))
    .filter((item: CollaboratorSlice) => Number.isFinite(item.value) && item.value !== 0);
}

function normalizeHeatmap(raw: any): HeatmapCell[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item: any) => {
      const day = Number(item?.day ?? item?.dayOfWeek ?? 0);
      const hour = Number(item?.hour ?? 0);
      const value = Number(item?.value ?? item?.earnings ?? 0);
      return { day, hour, value };
    })
    .filter((item: HeatmapCell) => Number.isFinite(item.value));
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${url}`);
  }
  return res.json();
}

export function useChartData(initialRange: RangeKey = "1M"): UseChartDataResult {
  const [range, setRange] = useState<RangeKey>(initialRange);
  const [raw, setRaw] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [reload, setReload] = useState<number>(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);

    const load = async () => {
      try {
        const [earningsRes, collabsRes, timeRes, heatRes] = await Promise.all([
          fetchJson("/api/analytics/earnings", controller.signal),
          fetchJson("/api/analytics/collaborators", controller.signal),
          fetchJson("/api/analytics/time-series", controller.signal),
          fetchJson("/api/analytics/heatmap", controller.signal),
        ]);
        if (!active) return;
        setRaw({
          earnings: normalizePoints(earningsRes),
          collaborators: normalizeCollaborators(collabsRes),
          timeSeries: normalizePoints(timeRes),
          heatmap: normalizeHeatmap(heatRes),
        });
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        if (active) setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (active) setLoading(false);
      }
    };

    load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [reload]);

  const data = useMemo<ChartData>(() => {
    const base: ChartData = raw ?? { earnings: [], collaborators: [], timeSeries: [], heatmap: [] };
    return {
      earnings: filterByRange(base.earnings, range),
      collaborators: base.collaborators,
      timeSeries: filterByRange(base.timeSeries, range),
      heatmap: base.heatmap,
    };
  }, [raw, range]);

  return {
    data,
    loading,
    error,
    range,
    setRange,
    refetch: () => setReload((r) => r + 1),
  };
}
