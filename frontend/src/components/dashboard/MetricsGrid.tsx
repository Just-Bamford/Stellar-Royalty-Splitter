import React from "react";
import { formatNumber, formatCurrency } from "../../utils/format";

export interface MetricsData {
  totalDistributed: number;
  totalTransactions: number;
  averagePayout: number;
  collaboratorCount: number;
}

export interface ExtraCard {
  label: string;
  value: string;
  unit?: string;
  className?: string;
}

interface MetricsGridProps {
  metrics: MetricsData;
  displayCurrency: string;
  /** Optional label overrides for the four default KPI cards. */
  labels?: Partial<{
    totalDistributed: string;
    totalTransactions: string;
    averagePayout: string;
    collaboratorCount: string;
  }>;
  /** Optional additional KPI cards appended after the four defaults. */
  extraCards?: ExtraCard[];
}

/**
 * MetricsGrid — four default KPI summary cards plus optional extra cards.
 * Labels can be overridden so the same component serves both the analytics
 * section and the portfolio overview section.
 */
export const MetricsGrid: React.FC<MetricsGridProps> = ({
  metrics,
  displayCurrency,
  labels = {},
  extraCards = [],
}) => {
  return (
    <div className="kpi-cards">
      <div className="kpi-card kpi-distributed">
        <div className="kpi-label">
          {labels.totalDistributed ?? "Total Distributed"}
        </div>
        <div className="kpi-value">
          {formatCurrency(metrics.totalDistributed, displayCurrency)}
        </div>
      </div>

      <div className="kpi-card kpi-transactions">
        <div className="kpi-label">
          {labels.totalTransactions ?? "Total Transactions"}
        </div>
        <div className="kpi-value">{formatNumber(metrics.totalTransactions)}</div>
        <div className="kpi-unit">payouts</div>
      </div>

      <div className="kpi-card kpi-average">
        <div className="kpi-label">
          {labels.averagePayout ?? "Average Payout"}
        </div>
        <div className="kpi-value">
          {formatCurrency(metrics.averagePayout, displayCurrency)}
        </div>
        <div className="kpi-unit">per transaction</div>
      </div>

      <div className="kpi-card kpi-collaborators">
        <div className="kpi-label">
          {labels.collaboratorCount ?? "Active Collaborators"}
        </div>
        <div className="kpi-value">{formatNumber(metrics.collaboratorCount)}</div>
        <div className="kpi-unit">unique addresses</div>
      </div>

      {extraCards.map((card, i) => (
        <div key={i} className={`kpi-card ${card.className ?? ""}`}>
          <div className="kpi-label">{card.label}</div>
          <div className="kpi-value">{card.value}</div>
          {card.unit && <div className="kpi-unit">{card.unit}</div>}
        </div>
      ))}
    </div>
  );
};

export default MetricsGrid;
