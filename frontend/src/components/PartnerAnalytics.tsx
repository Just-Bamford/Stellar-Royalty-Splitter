import React, { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  PartnerAnalytics,
  PartnerEndpointStat,
  PartnerPricingTier,
  PartnerRevenue,
} from "../api";
import "./PartnerAnalytics.css";

export const PARTNER_RANGE_OPTIONS = [7, 30, 90] as const;
export type PartnerRange = (typeof PARTNER_RANGE_OPTIONS)[number];

export interface PartnerAnalyticsProps {
  data: PartnerAnalytics;
  isLoading?: boolean;
  error?: string | null;
  onRangeChange?: (days: PartnerRange) => void;
}

/** Tier colours, shared by the key-mix donut and the tier badges. */
const TIER_COLORS: Record<string, string> = {
  free: "#3b82f6",
  pro: "#8b5cf6",
  enterprise: "#f59e0b",
};

const ENDPOINT_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
];

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatLimit(limit: number | null, window: "day" | "month"): string {
  if (limit === null) return "Unlimited";
  return `${formatNumber(limit)} / ${window}`;
}

/** Shorten "2026-09-28" to "Sep 28" for the chart axis. */
function shortDay(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Trim a path so long endpoint names do not break the table layout. */
function trimEndpoint(endpoint: string, max = 42): string {
  return endpoint.length <= max ? endpoint : `${endpoint.slice(0, max - 1)}…`;
}

function KpiCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  return (
    <div className={`partner-kpi partner-kpi--${tone}`} data-testid={`partner-kpi-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <span className="partner-kpi__label">{label}</span>
      <span className="partner-kpi__value">{value}</span>
      {hint && <span className="partner-kpi__hint">{hint}</span>}
    </div>
  );
}

function TopEndpointsTable({ endpoints }: { endpoints: PartnerEndpointStat[] }) {
  if (endpoints.length === 0) {
    return <p className="partner-empty">No API calls recorded in this window.</p>;
  }

  const maxCalls = Math.max(...endpoints.map((e) => e.calls));

  return (
    <table className="partner-table" data-testid="partner-top-endpoints">
      <thead>
        <tr>
          <th scope="col">Endpoint</th>
          <th scope="col">Calls</th>
          <th scope="col">Share</th>
          <th scope="col">Error rate</th>
          <th scope="col">Avg latency</th>
        </tr>
      </thead>
      <tbody>
        {endpoints.map((endpoint) => (
          <tr key={`${endpoint.method} ${endpoint.endpoint}`}>
            <td>
              <span className="partner-endpoint-method">{endpoint.method}</span>{" "}
              <span title={endpoint.endpoint}>{trimEndpoint(endpoint.endpoint)}</span>
            </td>
            <td>{formatNumber(endpoint.calls)}</td>
            <td>
              <span
                className="partner-share-bar"
                style={{ width: `${Math.max((endpoint.calls / maxCalls) * 100, 4)}%` }}
                aria-hidden="true"
              />
            </td>
            <td className={endpoint.errorRate > 5 ? "partner-error-high" : "partner-error-ok"}>
              {endpoint.errorRate.toFixed(1)}%
            </td>
            <td>{formatNumber(endpoint.avgDurationMs)} ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RevenueTable({ partners }: { partners: PartnerRevenue[] }) {
  if (partners.length === 0) {
    return <p className="partner-empty">No partners have issued API keys yet.</p>;
  }

  return (
    <table className="partner-table" data-testid="partner-revenue-table">
      <thead>
        <tr>
          <th scope="col">Partner</th>
          <th scope="col">Tier</th>
          <th scope="col">Keys</th>
          <th scope="col">Calls</th>
          <th scope="col">Base</th>
          <th scope="col">Overage</th>
          <th scope="col">Revenue</th>
        </tr>
      </thead>
      <tbody>
        {partners.map((partner) => (
          <tr key={partner.partnerId}>
            <td title={partner.partnerId}>{partner.partnerName}</td>
            <td>
              <span
                className={`partner-tier-badge partner-tier-badge--${partner.tier}`}
                data-testid={`partner-tier-${partner.partnerId}`}
              >
                {partner.tier}
                {partner.negotiated && " ★"}
              </span>
            </td>
            <td>
              {partner.activeKeys}/{partner.keys}
            </td>
            <td>{formatNumber(partner.calls)}</td>
            <td>{formatUsd(partner.baseCents)}</td>
            <td>
              {partner.overageCalls > 0
                ? `${formatNumber(partner.overageCalls)} (${formatUsd(partner.overageCents)})`
                : "—"}
            </td>
            <td>
              <strong>{formatUsd(partner.totalCents)}</strong>
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" colSpan={6}>
            Total monthly recurring revenue
          </th>
          <td data-testid="partner-total-mrr">{formatUsd(partners.reduce((sum, p) => sum + p.totalCents, 0))}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function TierCards({ tiers }: { tiers: PartnerPricingTier[] }) {
  return (
    <ul className="partner-tier-cards" data-testid="partner-tier-cards">
      {tiers.map((tier) => (
        <li
          key={tier.tier}
          className={`partner-tier-card partner-tier-card--${tier.tier}`}
          data-testid={`partner-tier-card-${tier.tier}`}
        >
          <span className="partner-tier-card__name">{tier.label}</span>
          <span className="partner-tier-card__price">
            {tier.monthlyPriceCents > 0 ? formatUsd(tier.monthlyPriceCents) : "Free"}
            {tier.monthlyPriceCents > 0 && <small>/mo</small>}
          </span>
          <span className="partner-tier-card__limits">
            {tier.dailyLimit !== null && `${formatNumber(tier.dailyLimit)} calls/day`}
            {tier.dailyLimit !== null && tier.monthlyLimit !== null && " · "}
            {tier.monthlyLimit !== null && `${formatNumber(tier.monthlyLimit)} calls/month`}
            {tier.dailyLimit === null && tier.monthlyLimit === null && "Custom limits"}
          </span>
          {tier.overageUnitPriceCents !== null && (
            <span className="partner-tier-card__overage">
              +{formatUsd(tier.overageUnitPriceCents)} per overage call
            </span>
          )}
          <span className="partner-tier-card__description">{tier.description}</span>
        </li>
      ))}
    </ul>
  );
}

export const PartnerAnalytics: React.FC<PartnerAnalyticsProps> = ({
  data,
  isLoading = false,
  error = null,
  onRangeChange,
}) => {
  const [range, setRange] = useState<PartnerRange>(30);

  const { overview, usageOverTime, topEndpoints, errorRates, revenue, tiers } = data;

  const usageChartData = useMemo(
    () => usageOverTime.series.map((point) => ({ ...point, label: shortDay(point.day) })),
    [usageOverTime.series],
  );

  const errorClass = useMemo(() => {
    if (errorRates.errorRate >= 10) return "bad" as const;
    if (errorRates.errorRate >= 2) return "warn" as const;
    return "good" as const;
  }, [errorRates.errorRate]);

  const keyMixData = useMemo(
    () =>
      (Object.keys(overview.keysByTier) as Array<keyof typeof overview.keysByTier>)
        .map((tier) => ({ tier, value: overview.keysByTier[tier] }))
        .filter((entry) => entry.value > 0),
    [overview.keysByTier],
  );

  const handleRangeChange = (days: PartnerRange) => {
    setRange(days);
    onRangeChange?.(days);
  };

  if (error) {
    return (
      <div className="partner-analytics" data-testid="partner-analytics">
        <div className="partner-error-banner" role="alert">
          {error}
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="partner-analytics" data-testid="partner-analytics">
        <div className="partner-loading" role="status">
          Loading partner analytics…
        </div>
      </div>
    );
  }

  return (
    <div className="partner-analytics" data-testid="partner-analytics">
      <header className="partner-header">
        <div>
          <h2>🔌 Partner API Analytics</h2>
          <p className="partner-subtitle">
            Metered API calls from marketplace partners, tiered rate limits and
            usage-based pricing.
          </p>
        </div>
        <div className="partner-range" role="group" aria-label="Analytics time range">
          {PARTNER_RANGE_OPTIONS.map((days) => (
            <button
              key={days}
              type="button"
              className={`partner-range__btn ${range === days ? "active" : ""}`}
              aria-pressed={range === days}
              onClick={() => handleRangeChange(days)}
            >
              {days}d
            </button>
          ))}
        </div>
      </header>

      <section className="partner-kpis" aria-label="Headline metrics">
        <KpiCard label="Total calls" value={formatNumber(overview.totalCalls)} hint={`last ${overview.days} days`} />
        <KpiCard
          label="Error rate"
          value={`${errorRates.errorRate.toFixed(1)}%`}
          hint={`${formatNumber(errorRates.totalErrors)} failed`}
          tone={errorClass}
        />
        <KpiCard
          label="Rate limited"
          value={formatNumber(overview.rateLimited)}
          hint="throttled requests"
          tone={overview.rateLimited > 0 ? "warn" : "default"}
        />
        <KpiCard
          label="Active keys"
          value={formatNumber(overview.activeKeys)}
          hint={`${formatNumber(overview.partners)} partners`}
        />
        <KpiCard
          label="MRR"
          value={formatUsd(overview.mrrCents)}
          hint={`${formatNumber(overview.totalKeys)} keys issued`}
          tone="good"
        />
        <KpiCard label="Avg latency" value={`${formatNumber(errorRates.avgDurationMs)} ms`} hint="per metered call" />
      </section>

      <section className="partner-panel" aria-label="API calls over time">
        <h3>API calls over time</h3>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={usageChartData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color, #e5e7eb)" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="calls" name="Calls" stroke="#3b82f6" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="errors" name="Errors" stroke="#ef4444" strokeWidth={2} dot={false} />
            <Line
              type="monotone"
              dataKey="rateLimited"
              name="Rate limited"
              stroke="#f59e0b"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </section>

      <div className="partner-grid">
        <section className="partner-panel" aria-label="Top endpoints">
          <h3>Top endpoints</h3>
          <TopEndpointsTable endpoints={topEndpoints.endpoints} />
        </section>

        <section className="partner-panel" aria-label="Error rates">
          <h3>Error rates</h3>
          <ul className="partner-error-list" data-testid="partner-error-list">
            <li>
              <span>Client errors (4xx)</span>
              <strong>{formatNumber(errorRates.clientErrors)}</strong>
            </li>
            <li>
              <span>Server errors (5xx)</span>
              <strong>{formatNumber(errorRates.serverErrors)}</strong>
            </li>
            <li>
              <span>Rate limited (429)</span>
              <strong>{formatNumber(errorRates.rateLimited)}</strong>
            </li>
          </ul>
          <h4>By status code</h4>
          {errorRates.byStatusCode.length === 0 ? (
            <p className="partner-empty">No calls recorded in this window.</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={errorRates.byStatusCode} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color, #e5e7eb)" />
                <XAxis dataKey="statusCode" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="calls" name="Calls" radius={[4, 4, 0, 0]}>
                  {errorRates.byStatusCode.map((entry) => (
                    <Cell
                      key={entry.statusCode}
                      fill={entry.statusCode >= 500 ? "#ef4444" : entry.statusCode >= 400 ? "#f59e0b" : "#10b981"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </section>
      </div>

      <div className="partner-grid">
        <section className="partner-panel" aria-label="Revenue per partner">
          <h3>Revenue per partner</h3>
          <RevenueTable partners={revenue.partners} />
        </section>

        <section className="partner-panel" aria-label="Keys by tier">
          <h3>Keys by tier</h3>
          {keyMixData.length === 0 ? (
            <p className="partner-empty">No API keys issued yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={keyMixData} dataKey="value" nameKey="tier" outerRadius={70} label>
                  {keyMixData.map((entry) => (
                    <Cell key={entry.tier} fill={TIER_COLORS[entry.tier] ?? "#6b7280"} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </section>
      </div>

      <section className="partner-panel" aria-label="Pricing tiers">
        <h3>Pricing tiers</h3>
        <TierCards tiers={tiers} />
        <p className="partner-footnote">
          Free: {formatLimit(tiers.find((t) => t.tier === "free")?.dailyLimit ?? null, "day")} · Pro:{" "}
          {formatLimit(tiers.find((t) => t.tier === "pro")?.monthlyLimit ?? null, "month")} · Enterprise: custom
          limits and negotiated pricing.
        </p>
      </section>
    </div>
  );
};

export default PartnerAnalytics;
