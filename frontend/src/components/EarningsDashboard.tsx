import React, { useState, useMemo, useRef } from "react";
import { type SecondarySale } from "../api";
import { useSettings } from "../context/SettingsContext";
import { queryClient } from "../lib/queryClient";
import { formatCurrency, formatNumber } from "../utils/format";
import { isCollaborator } from "../utils/collaborators";
import { CopyButton } from "./CopyButton";
import { Skeleton } from "./Skeleton";
import MultiContractComparison from "./MultiContractComparison";
import { LiveEarningsCounter } from "./LiveEarningsCounter";
import ContributorPerformanceComparison from "./ContributorPerformanceComparison";
import { useWebSocket, type DistributionEvent } from "../hooks/useWebSocket";
import {
  buildExportFilename,
  buildDashboardCSV,
  buildDashboardJSON,
  downloadDashboardCSV,
  downloadDashboardJSON,
  exportElementToPDF,
} from "../utils/dashboardExport";
import { useAnalytics } from "../hooks/queries/useAnalytics";
import { useCollaborators } from "../hooks/queries/useCollaborators";
import { useRoyaltyStats } from "../hooks/queries/useRoyaltyStats";
import { useTransactionHistory } from "../hooks/queries/useTransactionHistory";
import { useSecondarySales } from "../hooks/queries/useSecondarySales";
import { AdvancedAnalyticsDashboard } from "./AdvancedAnalyticsDashboard";
import "./EarningsDashboard.css";
import type { TransactionRecord } from "../api";

export interface CollaboratorEarning {
  address: string;
  basisPoints: number;
  totalEarned: number;
  payoutCount: number;
  avgPayout: number;
  firstActivity: string | null;
  lastActivity: string | null;
}

interface LiveDistribution {
  amount: number;
  type: DistributionEvent["type"];
  transactionId: string | number;
  timestamp: string;
}

export function distributionAmount(event: DistributionEvent): number | null {
  const raw = event.royaltyAmount ?? event.totalRoyalties ?? event.requestedAmount;
  if (raw === undefined || raw === null) return null;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

interface RecentPayout {
  id: string | number;
  type: "primary" | "secondary";
  timestamp: string;
  txHash: string | null;
  amount: string | number;
  status: string;
  details?: string;
}

interface EarningsDashboardProps {
  contractId?: string;
  walletAddress?: string | null;
}

export const EarningsDashboard: React.FC<EarningsDashboardProps> = ({
  contractId,
  walletAddress,
}) => {
  const { settings } = useSettings();

  // Multi-contract support (#multi-contract-earnings): users can track
  // several contract IDs in Settings. The selector below switches between
  // a single contract's dashboard and an aggregated comparison view.
  const trackedContracts = useMemo(
    () => settings.trackedContracts ?? [],
    [settings.trackedContracts],
  );
  const selectableContracts = useMemo(
    () =>
      Array.from(
        new Set([...trackedContracts, ...(contractId ? [contractId] : [])]),
      ).filter(Boolean),
    [trackedContracts, contractId],
  );
  const ALL_CONTRACTS = "__all__";
  const [selectedContract, setSelectedContract] = useState<string>(
    () => contractId ?? "",
  );

  // Follow the active contract chosen elsewhere in the app unless the user
  // is already viewing the aggregated view.
  React.useEffect(() => {
    if (contractId) {
      setSelectedContract((current) =>
        current === ALL_CONTRACTS ? current : contractId,
      );
    }
  }, [contractId]);

  const activeContract =
    selectedContract === ALL_CONTRACTS ? "" : selectedContract;
  const showComparison = selectedContract === ALL_CONTRACTS;

  const [latestDistribution, setLatestDistribution] = useState<LiveDistribution | null>(null);
  const [activeTab, setActiveTab] = useState<"all" | "primary" | "secondary">("all");
  const [searchQuery, setSearchQuery] = useState("");

  // #770: multi-format export (PDF/CSV/JSON) of the earnings dashboard.
  const dashboardRef = useRef<HTMLDivElement>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exporting, setExporting] = useState<"pdf" | "csv" | "json" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // React Query hooks — data is deduplicated, cached, and shared across components (#832)
  const analyticsQuery = useAnalytics(activeContract || undefined);
  const collaboratorsQuery = useCollaborators(activeContract || undefined);
  const royaltyStatsQuery = useRoyaltyStats(activeContract || undefined);
  const txHistoryQuery = useTransactionHistory(activeContract || undefined, 20, 0);
  const secondarySalesQuery = useSecondarySales(activeContract || undefined, 20, 0);

  const loading =
    analyticsQuery.isLoading ||
    collaboratorsQuery.isLoading ||
    royaltyStatsQuery.isLoading ||
    txHistoryQuery.isLoading ||
    secondarySalesQuery.isLoading;

  const error =
    (analyticsQuery.isError && collaboratorsQuery.isError)
      ? "Failed to load earnings dashboard data. Please try again."
      : null;

  // Refresh all queries for this contract
  const handleRefresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["analytics", activeContract] });
    void queryClient.invalidateQueries({ queryKey: ["collaborators", activeContract] });
    void queryClient.invalidateQueries({ queryKey: ["royaltyStats", activeContract] });
    void queryClient.invalidateQueries({ queryKey: ["txHistory", activeContract] });
    void queryClient.invalidateQueries({ queryKey: ["secondarySales", activeContract] });
  };

  // Handle distribution events for real-time earnings updates
  const handleDistributionEvent = React.useCallback(
    (event: DistributionEvent) => {
      if (event.contractId === activeContract) {
        handleRefresh();
        const amount = distributionAmount(event);
        if (amount !== null) {
          setLatestDistribution({
            amount,
            type: event.type,
            transactionId: event.transactionId,
            timestamp: event.timestamp,
          });
        }
      }
    },
    [activeContract],
  );

  // Connect to WebSocket for real-time distribution updates
  const { connected: wsConnected } = useWebSocket({
    walletAddress: walletAddress ?? null,
    onDistributionEvent: handleDistributionEvent,
    enabled: !!walletAddress && !!activeContract,
  });

  // ── Derive display data from query results ────────────────────────────────

  let totalDistributed = 0;
  let primaryTotal = 0;
  let secondaryTotal = 0;
  let collabStatsMap = new Map<string, { totalEarned: number; payoutCount: number }>();

  if (analyticsQuery.data?.success) {
    const data = analyticsQuery.data.data;
    totalDistributed = data.totalDistributed ?? 0;
    primaryTotal = data.primaryRoyaltiesTotal ?? 0;
    secondaryTotal = data.secondaryRoyaltiesTotal ?? 0;
    (data.collaboratorStats || []).forEach((c) => {
      collabStatsMap.set(c.address, {
        totalEarned: c.totalEarned,
        payoutCount: c.payoutCount,
      });
    });
  }
  // Fill secondary total from royalty stats if analytics didn't provide it
  if (!secondaryTotal && royaltyStatsQuery.data?.totalRoyaltiesGenerated) {
    const raw = royaltyStatsQuery.data.totalRoyaltiesGenerated;
    secondaryTotal = typeof raw === "number" ? raw : parseFloat(raw) || 0;
  }

  const collaborators: CollaboratorEarning[] = useMemo(() => {
    if (collaboratorsQuery.data && Array.isArray(collaboratorsQuery.data)) {
      return collaboratorsQuery.data.map((c) => {
        const stats = collabStatsMap.get(c.address) || { totalEarned: 0, payoutCount: 0 };
        return {
          address: c.address,
          basisPoints: c.basisPoints,
          totalEarned: stats.totalEarned,
          payoutCount: stats.payoutCount,
          avgPayout: stats.payoutCount > 0 ? stats.totalEarned / stats.payoutCount : 0,
        };
      });
    }
    if (collabStatsMap.size > 0) {
      return Array.from(collabStatsMap.entries()).map(([addr, stats]) => ({
        address: addr,
        basisPoints: 0,
        totalEarned: stats.totalEarned,
        payoutCount: stats.payoutCount,
        avgPayout: stats.payoutCount > 0 ? stats.totalEarned / stats.payoutCount : 0,
      }));
    }
    return [];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collaboratorsQuery.data, analyticsQuery.data]);

  const recentPayouts: RecentPayout[] = useMemo(() => {
    const list: RecentPayout[] = [];
    if (txHistoryQuery.data?.data) {
      txHistoryQuery.data.data.forEach((tx: TransactionRecord) => {
        list.push({
          id: `tx-${tx.id}`,
          type:
            tx.type === "secondary_distribute" || tx.type === "secondary_royalty"
              ? "secondary"
              : "primary",
          timestamp: tx.timestamp,
          txHash: tx.txHash,
          amount: tx.requestedAmount ?? "—",
          status: tx.status,
          details:
            tx.type === "initialize"
              ? "Contract Initialization"
              : `${tx.type === "distribute" ? "Primary Royalty Distribution" : "Secondary Royalty Distribution"}`,
        });
      });
    }
    if (secondarySalesQuery.data?.sales) {
      secondarySalesQuery.data.sales.forEach((sale: SecondarySale) => {
        list.push({
          id: `sale-${sale.id}`,
          type: "secondary",
          timestamp: sale.timestamp,
          txHash: sale.transactionHash,
          amount: sale.royaltyAmount,
          status: "confirmed",
          details: `NFT Resale (ID: ${sale.nftId})`,
        });
      });
    }
    return list.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }, [txHistoryQuery.data, secondarySalesQuery.data]);

  // ── Selectors ────────────────────────────────────────────────────────────

  const contractSelector = selectableContracts.length > 0 && (
    <div className="contract-selector" data-testid="contract-selector">
      <label htmlFor="earnings-contract-select">Contract</label>
      <select
        id="earnings-contract-select"
        value={selectedContract}
        onChange={(e) => setSelectedContract(e.target.value)}
      >
        {selectableContracts.map((id) => (
          <option key={id} value={id}>
            {`${id.slice(0, 8)}…${id.slice(-6)}`}
          </option>
        ))}
        {selectableContracts.length > 1 && (
          <option value={ALL_CONTRACTS}>
            All Contracts — Total &amp; Compare
          </option>
        )}
      </select>
    </div>
  );

  if (showComparison) {
    return (
      <div className="earnings-dashboard" data-testid="earnings-dashboard-comparison">
        <header className="earnings-header">
          <div className="earnings-header-info">
            <h1>Collaborator Earnings Dashboard</h1>
            <p className="subtitle">
              Aggregated earnings across all tracked contracts, with
              side-by-side comparison.
            </p>
          </div>
          {contractSelector}
        </header>
        <MultiContractComparison contractIds={selectableContracts} />
      </div>
    );
  }

  if (!activeContract && !showComparison) {
    return (
      <div className="earnings-dashboard-empty" data-testid="earnings-dashboard-empty">
        <div className="empty-card">
          <div className="empty-icon">💎</div>
          <h2>Collaborator Earnings Dashboard</h2>
          <p>Please select or initialize a contract to view total royalties and earnings breakdown.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="earnings-dashboard-loading" data-testid="earnings-dashboard-loading">
        <div className="skeleton-header">
          <Skeleton width="280px" height="32px" />
          <Skeleton width="400px" height="20px" className="mt-2" />
        </div>
        <div className="kpi-grid">
          <Skeleton height="110px" />
          <Skeleton height="110px" />
          <Skeleton height="110px" />
          <Skeleton height="110px" />
        </div>
        <Skeleton height="250px" className="mt-6" />
        <Skeleton height="300px" className="mt-6" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="earnings-dashboard-error" data-testid="earnings-dashboard-error">
        <div className="error-alert" role="alert">
          <div className="error-title">Error Loading Dashboard</div>
          <p>{error}</p>
          <button type="button" className="retry-btn" onClick={handleRefresh}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const filteredCollaborators = collaborators.filter((c) =>
    c.address.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredPayouts = recentPayouts.filter((p) => {
    if (activeTab === "primary") return p.type === "primary";
    if (activeTab === "secondary") return p.type === "secondary";
    return true;
  });

  const exportMetadata = { contractId: activeContract };

  const handleExportPDF = async () => {
    setExportError(null);
    setExportMenuOpen(false);
    if (!dashboardRef.current) return;
    setExporting("pdf");
    try {
      await exportElementToPDF(
        dashboardRef.current,
        buildExportFilename(exportMetadata, "pdf"),
      );
    } catch (err) {
      console.error("Dashboard PDF export failed:", err);
      setExportError("Failed to generate PDF export. Please try again.");
    } finally {
      setExporting(null);
    }
  };

  const handleExportCSV = () => {
    setExportError(null);
    setExportMenuOpen(false);
    try {
      const csv = buildDashboardCSV(filteredCollaborators, [
        { key: "address", label: "Collaborator Address" },
        { key: "basisPoints", label: "Basis Points" },
        { key: "totalEarned", label: "Total Earned" },
        { key: "payoutCount", label: "Payout Count" },
        { key: "avgPayout", label: "Average Payout" },
      ]);
      downloadDashboardCSV(csv, buildExportFilename(exportMetadata, "csv"));
    } catch (err) {
      console.error("Dashboard CSV export failed:", err);
      setExportError("Failed to generate CSV export. Please try again.");
    }
  };

  const handleExportJSON = () => {
    setExportError(null);
    setExportMenuOpen(false);
    try {
      const json = buildDashboardJSON(exportMetadata, {
        totalDistributed,
        primaryTotal,
        secondaryTotal,
        collaborators: filteredCollaborators,
        recentPayouts: filteredPayouts,
      });
      downloadDashboardJSON(json, buildExportFilename(exportMetadata, "json"));
    } catch (err) {
      console.error("Dashboard JSON export failed:", err);
      setExportError("Failed to generate JSON export. Please try again.");
    }
  };



  return (
    <div className="earnings-dashboard" data-testid="earnings-dashboard" ref={dashboardRef}>
      <header className="earnings-header">
        <div className="earnings-header-info">
          <h1>Collaborator Earnings Dashboard</h1>
          <p className="subtitle">
            Comprehensive overview of primary distributions, secondary resale royalties, and collaborator payouts.
          </p>
        </div>
        {contractSelector}
        <div className="export-dashboard" data-testid="export-dashboard">
          <button
            type="button"
            className="export-dashboard-btn"
            onClick={() => setExportMenuOpen((open) => !open)}
            aria-haspopup="true"
            aria-expanded={exportMenuOpen}
            disabled={exporting !== null}
          >
            {exporting ? `Exporting ${exporting.toUpperCase()}…` : "⬇️ Export"}
          </button>
          {exportMenuOpen && (
            <div className="export-dashboard-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => void handleExportPDF()}>
                Export as PDF
              </button>
              <button type="button" role="menuitem" onClick={handleExportCSV}>
                Export as CSV
              </button>
              <button type="button" role="menuitem" onClick={handleExportJSON}>
                Export as JSON
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          className="refresh-dashboard-btn"
          onClick={handleRefresh}
          title="Refresh dashboard data"
        >
          🔄 Refresh
        </button>
      </header>

      {latestDistribution && (
        <div className="live-distribution-banner" role="status" data-testid="latest-distribution">
          <span className="live-distribution-pulse" aria-hidden="true">●</span>
          <span>
            Latest distribution added <strong>{formatCurrency(latestDistribution.amount, settings.displayCurrency)}</strong>
            {latestDistribution.type === "secondary_sale_recorded" ? " from a secondary sale" : " to the dashboard"}.
          </span>
          <time dateTime={latestDistribution.timestamp}>
            {new Date(latestDistribution.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        </div>
      )}

      {exportError && (
        <div className="export-error-banner" role="alert">
          {exportError}
        </div>
      )}

      {/* KPI Cards Section */}
      <section className="kpi-grid" aria-label="Royalty Summary Statistics">
        <div className="kpi-card total-distributed-card">
          <div className="kpi-header">
            <span className="kpi-icon">💰</span>
            <span className="kpi-title">Total Distributed</span>
            {wsConnected && <span className="ws-indicator" title="Live updates active">●</span>}
          </div>
          <LiveEarningsCounter
            value={totalDistributed}
            currency={settings.displayCurrency}
            testId="total-distributed"
          />
          <div className="kpi-subtext">All-time primary &amp; secondary payouts</div>
        </div>

        <div className="kpi-card primary-royalties-card">
          <div className="kpi-header">
            <span className="kpi-icon">✨</span>
            <span className="kpi-title">Primary Royalties</span>
          </div>
          <LiveEarningsCounter
            value={primaryTotal}
            currency={settings.displayCurrency}
            testId="primary-royalties"
          />
          <div className="kpi-subtext">Direct contract distributions</div>
        </div>

        <div className="kpi-card secondary-royalties-card">
          <div className="kpi-header">
            <span className="kpi-icon">🔄</span>
            <span className="kpi-title">Secondary Royalties</span>
          </div>
          <LiveEarningsCounter
            value={secondaryTotal}
            currency={settings.displayCurrency}
            testId="secondary-royalties"
          />
          <div className="kpi-subtext">NFT marketplace resales</div>
        </div>

        <div className="kpi-card collaborator-count-card">
          <div className="kpi-header">
            <span className="kpi-icon">👥</span>
            <span className="kpi-title">Collaborators</span>
          </div>
          <div className="kpi-value">{formatNumber(collaborators.length)}</div>
          <div className="kpi-subtext">Allocated payout recipients</div>
        </div>
      </section>

      {/* Advanced Analytics Section */}
      <AdvancedAnalyticsDashboard payouts={recentPayouts} contractId={activeContract} />

      {/* Collaborators Breakdown Section */}
      <section className="dashboard-section collaborators-section" aria-labelledby="collab-earnings-heading">
        <div className="section-header">
          <div>
            <h2 id="collab-earnings-heading">Collaborator Allocations &amp; Earnings</h2>
            <p className="section-sub">Individual breakdown of shares and accumulated earnings.</p>
          </div>
          <div className="search-box">
            <input
              type="text"
              placeholder="Search by address..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search collaborators by address"
            />
            {searchQuery && (
              <button
                type="button"
                className="clear-search-btn"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        <div className="table-responsive">
          <table className="earnings-table">
            <thead>
              <tr>
                <th scope="col">Collaborator Address</th>
                <th scope="col" className="text-right">Share %</th>
                <th scope="col" className="text-right">Basis Points</th>
                <th scope="col" className="text-right">Total Earned</th>
                <th scope="col" className="text-right">Payout Count</th>
                <th scope="col" className="text-right">Avg Payout</th>
              </tr>
            </thead>
            <tbody>
              {filteredCollaborators.length > 0 ? (
                filteredCollaborators.map((c) => {
                  const sharePct = (c.basisPoints / 100).toFixed(2);
                  // #746: shared membership-check helper instead of an
                  // inline per-row address comparison.
                  const isConnectedUser = isCollaborator([c], walletAddress);
                  return (
                    <tr key={c.address} className={isConnectedUser ? "highlight-user-row" : ""}>
                      <td className="address-cell" data-label="Collaborator Address">
                        <div className="address-wrapper">
                          <span className="address-text" title={c.address}>
                            {c.address.slice(0, 10)}...{c.address.slice(-6)}
                          </span>
                          {isConnectedUser && <span className="you-badge">You</span>}
                          <CopyButton value={c.address} label="address" size="sm" />
                        </div>
                      </td>
                      <td className="text-right" data-label="Share %">
                        <span className="badge-share">{sharePct}%</span>
                      </td>
                      <td className="text-right" data-label="Basis Points">
                        {formatNumber(c.basisPoints)} bp
                      </td>
                      <td className="text-right font-medium" data-label="Total Earned">
                        {formatCurrency(c.totalEarned, settings.displayCurrency)}
                      </td>
                      <td className="text-right" data-label="Payout Count">
                        {formatNumber(c.payoutCount)}
                      </td>
                      <td className="text-right" data-label="Avg Payout">
                        {formatCurrency(c.avgPayout, settings.displayCurrency)}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="table-empty">
                    {searchQuery ? "No collaborators match your search query." : "No collaborator earnings found for this contract."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <ContributorPerformanceComparison
        collaborators={collaborators}
        currency={settings.displayCurrency}
      />

      {/* Recent Payout Activity Section */}
      <section className="dashboard-section recent-activity-section" aria-labelledby="payout-activity-heading">
        <div className="section-header">
          <div>
            <h2 id="payout-activity-heading">Recent Payout Activity</h2>
            <p className="section-sub">Latest primary distribution transactions and secondary royalty payouts.</p>
          </div>
          <div className="tabs-bar" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "all"}
              className={`tab-btn ${activeTab === "all" ? "active" : ""}`}
              onClick={() => setActiveTab("all")}
            >
              All Payouts
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "primary"}
              className={`tab-btn ${activeTab === "primary" ? "active" : ""}`}
              onClick={() => setActiveTab("primary")}
            >
              Primary
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "secondary"}
              className={`tab-btn ${activeTab === "secondary" ? "active" : ""}`}
              onClick={() => setActiveTab("secondary")}
            >
              Secondary
            </button>
          </div>
        </div>

        <div className="table-responsive">
          <table className="payouts-table">
            <thead>
              <tr>
                <th scope="col">Date / Time</th>
                <th scope="col">Type</th>
                <th scope="col">Details</th>
                <th scope="col" className="text-right">Amount</th>
                <th scope="col" className="text-center">Status</th>
                <th scope="col" className="text-right">Transaction Hash</th>
              </tr>
            </thead>
            <tbody>
              {filteredPayouts.length > 0 ? (
                filteredPayouts.map((p) => {
                  const formattedDate = new Date(p.timestamp).toLocaleString();
                  return (
                    <tr key={p.id}>
                      <td data-label="Date / Time" className="date-cell">
                        {formattedDate}
                      </td>
                      <td data-label="Type">
                        <span className={`type-badge type-${p.type}`}>
                          {p.type === "primary" ? "Primary" : "Secondary"}
                        </span>
                      </td>
                      <td data-label="Details" className="details-cell">
                        {p.details || "Royalty Payout"}
                      </td>
                      <td data-label="Amount" className="text-right font-medium">
                        {typeof p.amount === "number"
                          ? formatCurrency(p.amount, settings.displayCurrency)
                          : p.amount}
                      </td>
                      <td data-label="Status" className="text-center">
                        <span className={`status-pill status-${p.status}`}>
                          {p.status}
                        </span>
                      </td>
                      <td data-label="Transaction Hash" className="text-right">
                        {p.txHash ? (
                          <div className="tx-hash-wrapper">
                            <span className="tx-hash" title={p.txHash}>
                              {p.txHash.slice(0, 8)}...{p.txHash.slice(-6)}
                            </span>
                            <CopyButton value={p.txHash} label="transaction hash" size="sm" />
                          </div>
                        ) : (
                          <span className="no-hash">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="table-empty">
                    No recent payout activity found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export default EarningsDashboard;
