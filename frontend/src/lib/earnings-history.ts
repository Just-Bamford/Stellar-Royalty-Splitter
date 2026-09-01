export type EarningsTimeRange = "7d" | "30d" | "90d" | "all";

export interface DailySnapshot {
  date: string;
  contractId: string;
  amount: number;
}

export interface EarningsEvent {
  type: "contract_added" | "distribution_failure" | "contract_removed";
  contractId: string;
  date: string;
  label: string;
}

export interface ChartPoint {
  date: string;
  total: number;
  [contractId: string]: number | string;
}

export interface PeriodSummary {
  total: number;
  previousTotal: number;
  absoluteChange: number;
  percentChange: number | null;
  startDate: string;
  endDate: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function getRangeDates(range: EarningsTimeRange, referenceDate = new Date()): {
  start: string;
  end: string;
} {
  const end = new Date(referenceDate);
  end.setUTCHours(23, 59, 59, 999);

  if (range === "all") {
    return {
      start: "1970-01-01",
      end: end.toISOString().slice(0, 10),
    };
  }

  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const start = new Date(end.getTime() - (days - 1) * MS_PER_DAY);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export function fillMissingDays(
  snapshots: DailySnapshot[],
  startDate: string,
  endDate: string,
  contractIds: string[],
): DailySnapshot[] {
  const byKey = new Map<string, number>();
  for (const row of snapshots) {
    byKey.set(`${row.date}|${row.contractId}`, row.amount);
  }

  const filled: DailySnapshot[] = [];
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);

  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += MS_PER_DAY) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    for (const contractId of contractIds) {
      filled.push({
        date,
        contractId,
        amount: byKey.get(`${date}|${contractId}`) ?? 0,
      });
    }
  }

  return filled;
}

export function buildChartSeries(
  snapshots: DailySnapshot[],
  enabledContracts: Set<string>,
): ChartPoint[] {
  const byDate = new Map<string, ChartPoint>();

  for (const row of snapshots) {
    if (!enabledContracts.has(row.contractId)) continue;

    const existing = byDate.get(row.date) ?? { date: row.date, total: 0 };
    existing[row.contractId] = (Number(existing[row.contractId] ?? 0) + row.amount) as number;
    existing.total = Number((existing.total + row.amount).toFixed(2));
    byDate.set(row.date, existing);
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function calculatePeriodSummary(
  snapshots: DailySnapshot[],
  range: EarningsTimeRange,
  referenceDate = new Date(),
): PeriodSummary {
  const { start, end } = getRangeDates(range, referenceDate);
  const current = snapshots.filter((row) => row.date >= start && row.date <= end);
  const currentTotal = current.reduce((sum, row) => sum + row.amount, 0);

  const rangeDays =
    range === "all"
      ? Math.max(1, Math.ceil((new Date(end).getTime() - new Date(start).getTime()) / MS_PER_DAY) + 1)
      : range === "7d"
        ? 7
        : range === "30d"
          ? 30
          : 90;

  const previousEnd = new Date(`${start}T00:00:00.000Z`);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  const previousStart = new Date(previousEnd.getTime() - (rangeDays - 1) * MS_PER_DAY);

  const previousStartStr = previousStart.toISOString().slice(0, 10);
  const previousEndStr = previousEnd.toISOString().slice(0, 10);

  const previous = snapshots.filter(
    (row) => row.date >= previousStartStr && row.date <= previousEndStr,
  );
  const previousTotal = previous.reduce((sum, row) => sum + row.amount, 0);
  const absoluteChange = Number((currentTotal - previousTotal).toFixed(2));
  const percentChange =
    previousTotal === 0 ? (currentTotal === 0 ? 0 : null) : Number(((absoluteChange / previousTotal) * 100).toFixed(1));

  return {
    total: Number(currentTotal.toFixed(2)),
    previousTotal: Number(previousTotal.toFixed(2)),
    absoluteChange,
    percentChange,
    startDate: start,
    endDate: end,
  };
}

export function filterEventsInRange(events: EarningsEvent[], startDate: string, endDate: string) {
  return events.filter((event) => event.date.slice(0, 10) >= startDate && event.date.slice(0, 10) <= endDate);
}

export function uniqueContractIds(snapshots: DailySnapshot[]): string[] {
  return Array.from(new Set(snapshots.map((row) => row.contractId))).sort();
}

export function measureChartTransformMs(pointCount: number): number {
  const snapshots: DailySnapshot[] = Array.from({ length: pointCount }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + (index % 120))).toISOString().slice(0, 10),
    contractId: `C${index % 3}`,
    amount: index % 5,
  }));
  const contracts = new Set(uniqueContractIds(snapshots));
  const start = performance.now();
  buildChartSeries(snapshots, contracts);
  return performance.now() - start;
}
