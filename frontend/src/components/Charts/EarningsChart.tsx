import React, { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TimePoint } from '../../hooks/useChartData';

export interface EarningsChartProps {
  data: TimePoint[];
  height?: number;
}

function formatCurrency(value: number): string {
  return `\$$Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })`;
}

function formatDate(date: string): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function EarningsChart({ data, height = 280 }: EarningsChartProps) {
  const [active, setActive] = useState<boolean>(true);

  const gradientId = useMemo(() => `earnings-gradient-${Math.random().toString(36).slice(2, 9)}`, []);

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-slate-500 dark:text-slate-400" style={{ height }}>
        No earnings data yet
      </div>
    );
  }

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#2563eb" stopOpacity={0.35} />
              <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDash="3" vertical={} stroke="#e2e8f0" />
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
            tickFormatter={(value: number) => formatCompactCurrency(value)}
            width={56}
            tick={{ fill: '#64748b', fontSize: 11 }}
          />
          <Tooltip
            contentStyle={{
              borderRadius: 8,
              border: '1px solid #e2e8f0',
              fontSize: 12,
            }}
            formatter={(value: number, name, props: any) => [
              formatCurrency(value),
              formatDate(props?.payload?.date ?? ''),
            ]
            }
            labelFormatter={(value: string) => formatDate(value)}
          />
          <Area
            type="monotone"
            dataKey="value"
            name="Earnings"
            stroke="#2563eb"
            strokeWidth={2}
            fill={`url(${gradientId})`}
            animationDuration={600}
            hide{!active}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
      <button
        type="button"
        onClick={() => setActive((v) => !v)}
        className="mt-2 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${active ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-600'}`}
        />
        Earnings
      </button>
    </div>
  );
}

function formatCompactCurrency(value: number): string {
  if (Math.abs(value) >= 1000) {
    return `\$$${(value / 1000).toFixed(1)}k`;
  }
  return `\$${value}`;
}
