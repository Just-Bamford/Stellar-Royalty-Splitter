import React, { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TimePoint } from '../../hooks/useChartData';

export interface TimeSeriesChartProps {
  data: TimePoint[];
  height?: number;
  windowSize?: number;
  currency?: string;
}

function formatDate(date: string): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TimeSeriesChart({
  data,
  height = 280,
  windowSize = 7,
  currency = 'USD',
}: TimeSeriesChartProps) {
  const [showRaw, setShowRaw] = useState<boolean>(true);
  const [showMA, setShowMA] = useState<boolean>(true);

  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    const out = data.map((d) => ({ ...d, ma: null as number | null }));
    let sum = 0;
    for (let i = 0; i < out.length; i++) {
      sum += out[i].value;
      if (i >= windowSize) {
        sum -= out[i - windowSize].value;
      }
      const denom = Math.min(i + 1, windowSize);
      out[i].ma = sum / denom;
    }
    return out;
  }, [data, windowSize]);

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-slate-500 dark:text-slate-400" style={{ height }}>
        No time series data yet
      </div>
    );
  }

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickFormatter={formatDate}
            minTickGap={24}
            tick={{ fill: '#64748b', fontSize: 11 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v) => formatCompactCurrency(v, currency)}
            tick={{ fill: '#64748b', fontSize: 11 }}
          />
          <Tooltip
            contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }}
            formatter={(value: number) => [formatCompactCurrency(value, currency), 'Value']}
            labelFormatter={(value: string) => formatDate(value)}
          />
          <Line
            type="monotone"
            dataKey="value"
            name="Value"
            stroke="#2563eb"
            strokeWidth={2}
            dot={false}
            animationDuration={600}
            hide={!showRaw}
          />
          <Line
            type="monotone"
            dataKey="ma"
            name={`${windowSize}d moving avg`}
            stroke="#f59e0b"
            strokeWidth={2}
            strokeDasharray="4 4"
            dot={false}
            animationDuration={600}
            hide={!showMA}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className={`inline-flex items-center gap-1 ${showRaw ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400 dark:text-slate-500'}`}
        >
          <span className="inline-block h-2 w-2 rounded-full bg-blue-600" />
          Value
        </button>
        <button
          type="button"
          onClick={() => setShowMA((v) => !v)}
          className={`inline-flex items-center gap-1 ${showMA ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400 dark:text-slate-500'}`}
        >
          <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
          Moving avg ({windowSize}d)
        </button>
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

export default TimeSeriesChart;
