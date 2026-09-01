import { useState } from "react";
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
import {
  buildContractPerformanceSummary,
  type ContractPerformanceSummary,
} from "../utils/contractPerformance";
import { formatCurrency, formatNumber } from "../utils/format";
import { useAnalytics } from "../hooks/queries/useAnalytics";
import { useContractPerformance } from "../hooks/queries/useContractPerformance";
import { BulkOperationsPanel } from "./BulkOperationsPanel";

interface DashboardStats {
  totalDistributed: number;
  totalTransactions: number;
  averagePayout: number;
  primaryRoyaltiesTotal: number;
  secondaryRoyaltiesTotal: number;
  topEarners: Array<{ address: string; totalEarned: number; payouts: number }>;
  distributionTrends: Array<{ date: string; amount: number; count: number }>;
  collaboratorStats: Array<{
    address: string;
    totalEarned: number;
    payoutCount: number;
  }>;
}

interface DashboardProps {
  contractId: string;
}

/**
 * Dashboard — analytics overview for a given contract. Orchestrates the
 * DashboardHeader, MetricsGrid, EarningsChart, TopEarners, and CollaboratorList
 * sub-components around a single data fetch. Also renders the Portfolio
 * Overview (contract performance) section from the upstream enhancement.
 *
 * Data fetching is now handled by React Query hooks (#832):
 * - `useAnalytics` — per-contract analytics (deduplicates concurrent requests)
 * - `useContractPerformance` — portfolio-level performance summary
 */
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

  const activeDateRange = allTime ? undefined : dateRange;

  // React Query hooks — automatically deduplicated, cached, and background-refetched
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
      ? buildContractPerformanceSummary(performanceResponse.data.contracts, {
          sortBy,
          direction: sortDirection,
          limit: 100,
        })
      : null;

  const handleSelectContract = (contractId: string, event?: React.MouseEvent) => {
    if (event?.shiftKey) {
      // Shift+Click multi-select behavior
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
      // Mock implementation - shows confirmation dialog
      if (
        window.confirm(
          `Distribute to ${selectedContracts.size} selected contracts? (This is a preview)`
        )
      ) {
        // Placeholder for actual bulk distribute implementation
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
          <div className="empty-icon">📊</div>
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
      {/* ── Date range filter + refresh ───────────────────────────────── */}
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

      {/* ── Portfolio Overview (contract performance) ─────────────────── */}
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
                            <span className="address-full">{contract.contractId}</span>
                          </td>
                          <td className="text-right" data-label="Revenue">
                            {formatCurrency(contract.revenue, settings.displayCurrency)}
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
                            <span className={`status-pill status-${contract.status}`}>
                              {contract.status}
                            </span>
                          </td>
                        </tr>
                      ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="table-empty">
                        No contract activity found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ── Per-contract analytics ────────────────────────────────────── */}
      {stats && !loading && (
        <section className="dashboard-section" aria-labelledby="contract-analytics-heading">
          {stats.totalTransactions === 0 && (
            <div className="empty-data-warning" role="status">
              No data found for this period. Try widening your date range or
              selecting <strong>All time</strong>.
            </div>
          )}

          <h2 id="contract-analytics-heading" className="section-heading">
            Contract Analytics
          </h2>

          <MetricsGrid
            metrics={{
              totalDistributed: stats.totalDistributed,
              totalTransactions: stats.totalTransactions,
              averagePayout: stats.averagePayout,
              collaboratorCount: stats.collaboratorStats.length,
            }}
            displayCurrency={settings.displayCurrency}
            extraCards={[
              {
                label: "Primary Royalties",
                value: formatCurrency(stats.primaryRoyaltiesTotal ?? 0, settings.displayCurrency),
                unit: "from distributions",
                className: "kpi-primary",
              },
              {
                label: "Secondary Royalties",
                value: formatCurrency(stats.secondaryRoyaltiesTotal ?? 0, settings.displayCurrency),
                unit: "from resales",
                className: "kpi-secondary",
              },
            ]}
          />

          <EarningsChart
            trends={stats.distributionTrends}
            displayCurrency={settings.displayCurrency}
          />

          <TopEarners
            earners={stats.topEarners}
            totalDistributed={stats.totalDistributed}
            displayCurrency={settings.displayCurrency}
          />

          <CollaboratorList
            collaborators={stats.collaboratorStats}
            displayCurrency={settings.displayCurrency}
          />
        </section>
      )}
    </div>
  );
};
