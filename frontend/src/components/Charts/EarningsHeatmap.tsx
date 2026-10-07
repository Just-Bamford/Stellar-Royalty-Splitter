import React, { useMemo } from 'react';
import type { HeatmapCell } from '../../hooks/useChartData';

export interface EarningsHeatmapProps {
  data: HeatmapCell[];
  currency?: string;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function colorFor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return '#f1f5f9';
  const ratio = Math.min(1, value / max);
  const alpha = 0.15 + ratio * 0.85;
  return `rgba(37, 99, 235, ${alpha.toFixed(3)})`;
}

export function EarningsHeatmap({ data, currency = 'USD' }: EarningsHeatmapProps) {
  const max = useMemo(() => {
    if (!data || data.length === 0) return 0;
    return data.reduce((m, c) => Math.max(m, c.value), 0);
  }, [data]);

  const lookup = useMemo(() => {
    const map = new Map<string, number>();
    for (const cell of data ?? []) {
      map.set(`${cell.day}-${cell.hour}`, cell.value);
    }
    return map;
  }, [data]);

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-slate-500 dark:text-slate-400">
        No heatmap data yet
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto">
      <div className="inline-block min-w-[640px]">
        <div className="flex">
          <div className="w-12 shrink-0" />
          {HOURS.map((hour) => (
            <div
              key={hour}
              className="w-6 text-center text-[10px] text-slate-400 dark:text-slate-500"
            >
              {hour % 3 === 0 ? hour : ''}
            </div>
          ))}
        </div>
        {DAYS.map((dayName, day) => (
          <div key={dayName} className="flex items-center">
            <div className="w-12 shrink-0 text-xs text-slate-500 dark:text-slate-400">
              {dayName}
            </div>
            {HOURS.map((hour) => {
              const value = lookup.get(`${day}-${hour}`) ?? 0;
              return (
                <div
                  key={hour}
                  className="m-0.5 h-6 w-6 rounded-sm border border-slate-200 dark:border-slate-700"
                  style={{ backgroundColor: colorFor(value, max) }}
                  title={`${dayName} ${hour}:00 - ${formatCompactCurrency(value, currency)}`}
                  data-testid="heatmap-cell"
                />
              );
            })}
          </div>
        ))}
        <div className="mt-3 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>Low</span>
          <div className="flex">
            {[0, 0.25, 0.5, 0.75, 1].map((r) => (
              <div
                key={r}
                className="h-3 w-6 border border-slate-200 dark:border-slate-700"
                style={{ backgroundColor: colorFor(r * max, max) }}
              />
            ))}
          </div>
          <span>High</span>
        </div>
      </div>
    </div>
  );
}

function formatCompactCurrency(value: number, currency: string = 'USD'): string {
  const prefix = currency === 'USD' || currency === '$' ? '$' : `${currency} `;
  if (Math.abs(value) >= 1000) {
    return `${prefix}${(value / 1000).toFixed(1)}k`;
  }
  return `${prefix}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export default EarningsHeatmap;
