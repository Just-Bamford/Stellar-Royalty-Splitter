import { useState, useMemo, useCallback } from "react";
import "./Dashboard.css";
import { useSettings } from "../context/SettingsContext";
import { DashboardSkeleton } from "./Skeleton";
import {
  DashboardHeader,
  MetricsGrid,
  EarningsChart,
  TopEarners,
  CollaboratorList,
} from "./dashboard/index";
import type { DateRange } from "./dashboard/index";
import { buildContractPerformanceSummary } from "../utils/contractPerformance";
import { formatCurrency, formatNumber } from "../utils/format";
import { useAnalytics } from "../hooks/queries/useAnalytics";
import { useContractPerformance } from "../hooks/queries/useContractPerformance";
import { BulkOperationsPanel } from "./BulkOperationsPanel";
import { useChartData } from "../hooks/useChartData";
import {
  EarningsAreaChart,
  CollaboratorDonutChart,
  TimeSeriesChart,
  EarningsHeatmap,
  ChartCard,
} from "./Charts";
import type { ChartRange } from "../hooks/useChartData";

interface DashboardProps {
  contractId: string;
}

export const Dashboard: React.FC<DashboardProps> = ({ contractId }) => {
  const { settings } = useSettings();
  const [allTime, setAllTime] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>({
    start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0],
    end: new Date().toISOString().split("T")[0],
  });
  const [sortBy, setSortBy] = useState<"revenue" | "transactions" | "name">("revenue");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [selectedContracts, setSelectedContracts] = useState<Set<string>>(new Set());
  const [showAggregated, setShowAggregated] = useState(false);
  const [bulkOperationLoading, setBulkOperationLoading] = useState(false);
  const [chartRange, setChartRange] = useState<ChartRange>("3M");

  const activeDateRange = allTime ? undefined : dateRange;

  const {
    data: analyticsResponse,
    isLoading: loading,
    error: analyticsError,
    refetch: refetchAnalytics,
  } = useAnalytics(contractId || undefined, activeDateRange);

  const {
    data: performanceResponse,
    isLoading: performanceLoading,
    error: performanceErr,
    refetch: refetchPerformance,
  } = useContractPerformance(
    activeDateRange,
    { sortBy, direction: sortDirection, limit: 100 },
  );

  const stats = analyticsResponse?.success ? analyticsResponse.data : null;
  const error = analyticsError ? (analyticsError as Error).message || "Error loading analytics data" : null;
  const performanceError = performanceErr ? (performanceErr as Error).message || "Error loading contract performance data" : null;

  const performanceData =
    performanceResponse?.success && performanceResponse.data?.contracts
      ? buildContractPerformanceSummary(
          performanceResponse.data.contracts.map((row) => ({
            ...row,
            status: row.status as "active" | "inactive" | "pending" | undefined,
          })),
          {
            sortBy,
            direction: sortDirection,
            limit: 100,
          },
        )
      : null;

  const chartData = useChartData(stats, chartRange);

  const handleSelectContract = (contractId: string, event?: React.MouseEvent) => {
    if (event?.shiftKey) {
      setSelectedContracts(new Set(selectedContracts).add(contractId));
    } else {
      const newSet = new Set(selectedContracts);
      if (newSet.has(contractId)) {
        newSet.delete(contractId);
      } else {
        newSet.add(contractId);
      }
      setSelectedContracts(newSet);
    }
  };

  const handleSelectAll = () => {
    if (performanceData && performanceData.contracts.length > 0) {
      if (selectedContracts.size === performanceData.contracts.length) {
        setSelectedContracts(new Set());
      } else {
        setSelectedContracts(
          new Set(performanceData.contracts.map((c) => c.contractId))
        );
      }
    }
  };

  const handleBulkDistribute = async () => {
    if (selectedContracts.size === 0) return;
    setBulkOperationLoading(true);
    try {
      if (
        window.confirm(
          `Distribute to ${selectedContracts.size} selected contracts? (This is a preview)`
        )
      ) {
        console.log("Bulk distribute to:", selectedContracts);
      }
    } finally {
      setBulkOperationLoading(false);
    }
  };

  const handleBulkExport = () => {
    if (selectedContracts.size === 0) return;
    const selectedData = performanceData?.contracts.filter((c) =>
      selectedContracts.has(c.contractId)
    );
    const csv = [
      ["Contract ID", "Revenue", "Transactions", "Status"],
      ...(selectedData?.map((c) => [
        c.contractId,
        c.revenue,
        c.transactions,
        c.status,
      ]) || []),
    ]
      .map((row) => row.join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `contracts-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
  };

  const handleAggregatedView = () => {
    setShowAggregated(!showAggregated);
  };

  if (!contractId) {
    return (
      <div className="dashboard-empty">
        <div className="empty-state">
          <div className="empty-icon">💏</div>
          <h2>No Contract Selected</h2>
          <p>Please initialize or select a contract to view analytics.</p>
        </div>
      </div>
    );
  }

  const isLoading = loading || performanceLoading;

  function formatContractId(id: string): string {
    if (id.length <= 16) return id;
    return `${id.slice(0, 8)}…${id.slice(-6)}`;
  }

  return (
    <div className="dashboard">
      <DashboardHeader
        allTime={allTime}
        dateRange={dateRange}
        onAllTimeToggle={() => setAllTime((v) => !v)}
        onDateRangeChange={setDateRange}
        onRefresh={() => {
          void refetchAnalytics();
          void refetchPerformance();
        }}
        sortBy={sortBy}
        onSortByChange={setSortBy}
        sortDirection={sortDirection}
        onSortDirectionChange={setSortDirection}
        loading={isLoading}
      />

      {isLoading && <DashboardSkeleton />}
      {error && <div className="error-message" role="alert">{error}</div>}
      {performanceError && <div className="error-message" role="alert">{performanceError}</div>}

      {/* ── Advanced Visualizations ── */}
      {!isLoading && chartData && (
        <section className="dashboard-section charts-section" aria-labelledby="charts-heading">
          <div className="section-heading-row">
            <h2 id="charts-heading" className="section-heading">
              Analytics Visualizations
            </h2>
            <div className="chart-range-selector" role="group" aria-label="Chart time range">
              {(["1W", "1M", "3M", "1Y", "all"] as ChartRange[]).map((range) => (
                <button
                  key={range}
                  type="button"
                  className={`chart-range-btn ${chartRange === range ? "active" : ""}`}
                  onClick={() => setChartRange(range)}
                  aria-pressed={chartRange === range}
                >
                  {range === "all" ? "All" : range}
                </button>
              ))}
            </div>
          </div>

          <div className="charts-grid">
            <ChartCard title="Real-time Earnings" subtitle="Cumulative earnings over time" exportName="earnings-area">
              <EarningsAreaChart data={chartData.earningsSeries} currency={settings.displayCurrency} />
            </ChartCard>
            <ChartCard title="Collaborator Breakdown" subtitle="Earnings distribution by collaborator" exportName="collaborator-donut">
              <CollaboratorDonutChart data={chartData.collaboratorBreakdown} currency={settings.displayCurrency} />
            </ChartCard>
            <ChartCard title="Distribution Over Time" subtitle="Payouts with moving average" exportName="time-series">
              <TimeSeriesChart data={chartData.timeSeries} currency={settings.displayCurrency} />
            </ChartCard>
            <ChartCard title="Peak Earning Times" subtitle="Earnings by day-of-week and hour" exportName="earnings-heatmap">
              <EarningsHeatmap data={chartData.heatmap} currency={settings.displayCurrency} />
            </ChartCard>
          </div>
        </section>
      )}

      {/* ── Portfolio Overview ── */}
      {performanceData && !performanceLoading && (
        <section className="dashboard-section" aria-labelledby="portfolio-overview-heading">
          <h2 id="portfolio-overview-heading" className="section-heading">
            Portfolio Overview
          </h2>
          <MetricsGrid
            metrics={{
              totalDistributed: showAggregated
                ? Array.from(selectedContracts).reduce((sum, id) => {
                    const contract = performanceData.contracts.find((c) => c.contractId === id);
                    return sum + (contract?.revenue || 0);
                  }, 0)
                : performanceData.totalRevenue,
              totalTransactions: showAggregated
                ? Array.from(selectedContracts).reduce((sum, id) => {
                    const contract = performanceData.contracts.find((c) => c.contractId === id);
                    return sum + (contract?.transactions || 0);
                  }, 0)
                : performanceData.transactionsThisMonth,
              averagePayout: performanceData.totalRevenue / Math.max(performanceData.transactionsThisMonth, 1),
              collaboratorCount: showAggregated ? selectedContracts.size : performanceData.activeContracts,
            }}
            displayCurrency={settings.displayCurrency}
            labels={{
              totalDistributed: showAggregated ? "Selected Revenue" : "Total Revenue",
              totalTransactions: showAggregated ? "Selected Transactions" : "Transactions This Month",
              collaboratorCount: showAggregated ? "Selected Contracts" : "Active Contracts",
            }}
          />

          {selectedContracts.size > 0 && (
            <BulkOperationsPanel
              selectedCount={selectedContracts.size}
              onBulkDistribute={handleBulkDistribute}
              onBulkExport={handleBulkExport}
              onAggregatedView={handleAggregatedView}
              loading={bulkOperationLoading}
            />
          )}

          <div className="performance-table-section">
            <div className="section-heading-row">
              <h2 className="section-heading">Contract Performance</h2>
              <span className="section-meta">
                {selectedContracts.size > 0
                  ? `${selectedContracts.size} selected`
                  : `${formatNumber(performanceData.contracts.length)} contracts`}
              </span>
            </div>
            <div className="stats-table stats-table-responsive">
              <table>
                <thead>
                  <tr>
                    <th scope="col" className="checkbox-col">
                      <input
                        type="checkbox"
                        checked={
                          performanceData.contracts.length > 0 &&
                          selectedContracts.size === performanceData.contracts.length
                        }
                        onChange={handleSelectAll}
                        aria-label="Select all contracts"
                      />
                    </th>
                    <th scope="col">Contract ID</th>
                    <th scope="col" className="text-right">Revenue</th>
                    <th scope="col" className="text-right">Transactions</th>
                    <th scope="col" className="text-right">Last Activity</th>
                    <th scope="col" className="text-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {performanceData.contracts.length > 0 ? (
                    performanceData.contracts
                      .filter((c) => !showAggregated || selectedContracts.has(c.contractId))
                      .map((contract) => (
                        <tr
                          key={contract.contractId}
                          className={selectedContracts.has(contract.contractId) ? "selected" : ""}
                        >
                          <td className="checkbox-col">
                            <input
                              type="checkbox"
                              checked={selectedContracts.has(contract.contractId)}
                              onChange={(e) =>
                                handleSelectContract(contract.contractId, e as any)
                              }
                              aria-label={`Select contract ${formatContractId(contract.contractId)}`}
                            />
                          </td>
                          <td
                            className="address-cell"
                            data-label="Contract ID"
                            title={contract.contractId}
                          >
                            <span className="address-short">
                              {formatContractId(contract.contractId)}
                            </span>
                          </td>
                          <td className="text-right" data-label="Revenue">
                            {formatcurrency(contract.revenue, settings.displayCurrency)}
                          </td>
                          <td className="text-right" data-label="Transactions">
                            {formatNumber(contract.transactions)}
                          </td>
                          <td className="text-right" data-label="Last Activity">
                            {contract.lastActivity
                              ? new Date(contract.lastActivity).toLocaleDateString()
                              : "—"}
                          </td>
                          <td className="text-right" data-label="Status">
                            <span className={`status-badge status-${contract.status || "unknown"}`}>
                              {contract.status || "unknown"}
                            </span>
                          </td>
                        </tr>
                      ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="empty-row">
                        No contract performance data available.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ── Top Earners & Collaborators ── */}
      {stats && !loading && (
        <section className="dashboard-section" aria-labelledby="earners-heading">
          <h2 id="earners-heading" className="section-heading">
            Top Earners & Collaborators
          </h2>
          <div className="dashboard-two-col">
            <TopEarners
              earners={stats.topEarners || []}
              currency={settings.displayCurrency}
            />
            <CollaboratorList
              collaborators={stats.collaborators || []}
              currency={settings.displayCurrency}
            />
          </div>
        </section>
      )}
    </div>
  );
};

export default Dashboard;
