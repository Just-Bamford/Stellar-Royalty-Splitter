import React, { useMemo, useState } from 'react';
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { CollaboratorSlice } from '../../hooks/useChartData';

export interface CollaboratorDonutProps {
  data: CollaboratorSlice[];
  height?: number;
}

const COLORS = [
  '#2563eb',
  '#7ba5f7',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#f4728b',
  '#06b6d4',
  '#84cc16',
];

function formatCurrency(value: number): string {
  return `\$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })`;
}

export default function CollaboratorDonut({ data, height = 280 }: CollaboratorDonutProps) {
  const [hidden, setHidden] = useState<Record<string, boolean>>({});

  const sorted = useMemo(() => {
    return [...data].sort((a, b) => b.value - a.value);
  }, [data]);

  const visible = useMemo(() => sorted.filter((d) => !hidden[d.name]), [sorted, hidden]);

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-slate-500 dark:text-slate-400" style={{ height }}>
        No collaborator data yet
      </div>
    );
  }

  const total = visible.reduce((sum, d) => sum + d.value, 0);

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={visible}
            dataKey="value"
            nameKey="name"
            innerRadius='60%'
            outerRadius='85%'
            paddingAngle={2}
            animationDuration={600}
            stroke='#ffffff'
          >
            {visible.map((entry, index) => (
              <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }}
            formatter={(value: number, name: string) => [
              formatCompactCurrency(value),
              `${name} (${total ? Math.round((value / total) * 100) : 0}%)`,
            ]}
          />
          <Legend
            onClick={(entry: any) => {
              const name = entry?.value ?? entry?.dataKey;
              if (!name) return;
              setHidden((prev) => ({ ...prev, [name]: !prev[name] }));
            }}
            formatter={(value: string) => (
              <span className={`text-xs ${hidden[value] ? 'opacity-40' : ''}`}>{value}</span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function formatCompactCurrency(value: number): string {
  if (Math.abs(value) >= 1000) {
    return `\$$${(value / 1000).toFixed(1)}k`;
  }
  return `\$${value}`;
}
