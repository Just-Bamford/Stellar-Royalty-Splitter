import { BarChart, Bar, XAxis, Cell, ResponsiveContainer, Tooltip } from "recharts";
import "./CollaboratorAllocationChart.css";

interface Collaborator {
  address: string;
  basisPoints: number;
}

interface Props {
  collaborators: Collaborator[];
}

// Fixed categorical order — never cycled, never generated per-render.
// Chosen to stay legible for readers with color-vision deficiency at
// adjacent-pair separation (validated ordering: blue, orange, aqua, yellow,
// magenta, green, violet, red).
const SERIES_COLORS = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#4a3aa7",
  "#e34948",
];

// Beyond this many distinct contributors, the tail folds into a single
// "Other" segment rather than generating additional hues — a generated 9th
// color is indistinguishable from an existing one for CVD readers, and past
// ~8 series a legend stops being scannable. The exact per-contributor
// percentages remain fully visible in the table above/below this chart
// regardless of how many fold into "Other" here.
const MAX_DIRECT_SLICES = 8;

// Distinct patterns (beyond color) so contributors are never told apart by
// hue alone — each segment gets a small positional marker in its legend row
// in addition to its color swatch and exact percentage text.
const PATTERN_MARKERS = ["●", "▲", "■", "◆", "★", "▶", "◼", "✚"];

function formatPercent(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2);
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

export default function CollaboratorAllocationChart({ collaborators }: Props) {
  if (!collaborators.length) return null;

  const sorted = [...collaborators].sort((a, b) => b.basisPoints - a.basisPoints);
  const direct = sorted.slice(0, MAX_DIRECT_SLICES);
  const rest = sorted.slice(MAX_DIRECT_SLICES);
  const otherBasisPoints = rest.reduce((sum, c) => sum + c.basisPoints, 0);

  type Segment = {
    key: string;
    label: string;
    fullAddress: string | null;
    basisPoints: number;
    color: string;
    marker: string;
  };

  const segments: Segment[] = direct.map((c, i) => ({
    key: c.address,
    label: truncateAddress(c.address),
    fullAddress: c.address,
    basisPoints: c.basisPoints,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    marker: PATTERN_MARKERS[i % PATTERN_MARKERS.length],
  }));

  if (rest.length > 0) {
    segments.push({
      key: "__other__",
      label: `Other (${rest.length} contributor${rest.length !== 1 ? "s" : ""})`,
      fullAddress: null,
      basisPoints: otherBasisPoints,
      color: "#898781",
      marker: "…",
    });
  }

  // Single stacked bar: one row, one segment per contributor (or "Other").
  // Recharts wants row-shaped data for a stacked bar, so each segment
  // becomes its own numeric key on a single data row.
  const chartRow: Record<string, number> = {};
  for (const seg of segments) chartRow[seg.key] = seg.basisPoints;

  const totalBasisPoints = segments.reduce((sum, s) => sum + s.basisPoints, 0);

  // Screen-reader text equivalent — states every contributor's exact share
  // as text, independent of the visual chart, matching the numbers already
  // shown in the table.
  const srSummary = segments
    .map((s) =>
      s.fullAddress
        ? `${s.fullAddress}: ${formatPercent(s.basisPoints)}%`
        : `${s.label}: ${formatPercent(s.basisPoints)}%`
    )
    .join("; ");

  return (
    <div className="allocation-chart" data-testid="collaborator-allocation-chart">
      <div className="allocation-chart-header">
        <span className="allocation-chart-title">Allocation breakdown</span>
        <span className="allocation-chart-total">
          {formatPercent(totalBasisPoints)}% allocated
        </span>
      </div>

      <span className="sr-only" role="img" aria-label={`Royalty allocation breakdown: ${srSummary}`}>
        Royalty allocation breakdown: {srSummary}
      </span>

      <div className="allocation-chart-bar" aria-hidden="true">
        <ResponsiveContainer width="100%" height={40}>
          <BarChart layout="vertical" data={[chartRow]} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <XAxis type="number" domain={[0, 10000]} hide />
            <Tooltip
              formatter={(value: number, name: string) => {
                const seg = segments.find((s) => s.key === name);
                return [`${formatPercent(value)}%`, seg?.label ?? name];
              }}
            />
            {segments.map((seg) => (
              <Bar
                key={seg.key}
                dataKey={seg.key}
                stackId="allocations"
                isAnimationActive={false}
                radius={0}
              >
                <Cell fill={seg.color} />
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <ul className="allocation-chart-legend">
        {segments.map((seg) => (
          <li key={seg.key} className="allocation-chart-legend-item">
            <span
              className="allocation-chart-swatch"
              style={{ background: seg.color }}
              aria-hidden="true"
            >
              {seg.marker}
            </span>
            <span className="allocation-chart-legend-label" title={seg.fullAddress ?? undefined}>
              {seg.label}
            </span>
            <span className="allocation-chart-legend-value">
              {formatPercent(seg.basisPoints)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
