import { useEffect, useState, useRef, useCallback, useMemo } from "react";

import { api } from "../api";
import { queryClient } from "../lib/queryClient";
import { TableSkeleton } from "./Skeleton";
import CollaboratorAllocationChart from "./CollaboratorAllocationChart";
import {
  buildCollaboratorsCSV,
  buildCollaboratorsJSON,
  buildExportFilename,
  downloadCSV,
  downloadJSON,
  type CollaboratorExportItem,
} from "../utils/export";
import "./CollaboratorTable.css";

interface Collaborator {
  address: string;
  basisPoints: number;
}

interface Props {
  contractId: string;
  refreshKey: number;
}

type SortKey = "address" | "share";

/* ── Filter types ──────────────────────────────────────────────────────────── */

type ShareRange = "all" | "gt10" | "r5to10" | "r1to5" | "lt1";
type PaymentStatus = "all" | "paid" | "unpaid";

interface ActiveFilters {
  shareRange: ShareRange;
  paymentStatus: PaymentStatus;
}


const SHARE_RANGE_LABELS: Record<ShareRange, string> = {
  all: "All shares",
  gt10: "> 10%",
  r5to10: "5 – 10%",
  r1to5: "1 – 5%",
  lt1: "< 1%",
};

const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  all: "All statuses",
  paid: "Paid",
  unpaid: "Unpaid",
};

/* ── Persistent names: single JSON blob per contract (O(1) read) ───────────── */

const NAME_STORAGE_KEY = "srs_collab_names";

function loadNames(contractId: string): Map<string, string> {
  try {
    const blob = localStorage.getItem(NAME_STORAGE_KEY);
    if (!blob) return new Map();
    const all: Record<string, Record<string, string>> = JSON.parse(blob);
    const contractNames = all[contractId];
    if (!contractNames) return new Map();
    return new Map(Object.entries(contractNames));
  } catch {
    return new Map();
  }
}

function saveNames(contractId: string, names: Map<string, string>) {
  try {
    const blob = localStorage.getItem(NAME_STORAGE_KEY);
    const all: Record<string, Record<string, string>> = blob
      ? JSON.parse(blob)
      : {};
    const contractNames: Record<string, string> = {};
    names.forEach((value, key) => {
      contractNames[key] = value;
    });
    all[contractId] = contractNames;
    localStorage.setItem(NAME_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // localStorage may be full or unavailable
  }
}

/* ── Share range predicate ─────────────────────────────────────────────────── */

function matchesShareRange(basisPoints: number, range: ShareRange): boolean {
  const pct = basisPoints / 100;
  switch (range) {
    case "all":
      return true;
    case "gt10":
      return pct > 10;
    case "r5to10":
      return pct >= 5 && pct <= 10;
    case "r1to5":
      return pct >= 1 && pct < 5;
    case "lt1":
      return pct < 1;
  }
}

export default function CollaboratorTable({ contractId, refreshKey }: Props) {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Bumped by the error state's Retry button to re-run the fetch effect
  // below without requiring the parent to change `refreshKey` (#747).
  const [retryCount, setRetryCount] = useState(0);
  const [sort, setSort] = useState<SortKey>("share");
  const [copied, setCopied] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);


  // ── debounced search ──────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── filters ───────────────────────────────────────────────────────────
  const [filters, setFilters] = useState<ActiveFilters>({
    shareRange: "all",
    paymentStatus: "all",
  });

  // ── editable names ────────────────────────────────────────────────────
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // ── payment data (from analytics) ─────────────────────────────────────
  const [paymentData, setPaymentData] = useState<Map<string, number> | null>(
    null,
  );

  // ── tier data ──────────────────────────────────────────────────────────
  const [tierData, setTierData] = useState<Map<string, string> | null>(null);

  useEffect(() => {
    if (!contractId) return;
    let cancelled = false;

    async function loadCollaborators() {
      setLoading(true);
      setError("");
      try {
        const [nextCollaborators, analyticsRes, tiersRes] = await Promise.all([
          api.getCollaborators(contractId),
          api.getAnalytics(contractId).catch(() => null),
          api.getContractTiers(contractId).catch(() => ({ data: [] })),
        ]);

        if (cancelled) return;

        queryClient.setQueryData(["collaborators", contractId], nextCollaborators);
        if (analyticsRes) {
          queryClient.setQueryData(["analytics", contractId], analyticsRes);
        }
        setCollaborators(nextCollaborators);
        setNames(loadNames(contractId));

        if (analyticsRes?.success && analyticsRes.data.collaboratorStats) {
          const map = new Map<string, number>();
          for (const stat of analyticsRes.data.collaboratorStats) {
            map.set(stat.address, stat.payoutCount);
          }
          setPaymentData(map);
        } else {
          setPaymentData(null);
        }

        const tierMap = new Map<string, string>();
        for (const tier of tiersRes.data ?? []) {
          tierMap.set(tier.walletAddress, tier.tier);
        }
        setTierData(tierMap);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load collaborators");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadCollaborators();

    return () => {
      cancelled = true;
    };
  }, [contractId, refreshKey, retryCount]);

  /* ── Debounced search ────────────────────────────────────────────────── */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearch(searchInput);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchInput]);

  function copyAddress(address: string) {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(address);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  /* ── Name editing ────────────────────────────────────────────────────── */
  const startEditing = useCallback(
    (address: string) => {
      setEditingName(address);
      setEditValue(names.get(address) ?? "");
    },
    [names],
  );

  const commitName = useCallback(
    (address: string) => {
      const updated = new Map(names);
      if (editValue.trim()) {
        updated.set(address, editValue.trim());
      } else {
        updated.delete(address);
      }
      setNames(updated);
      saveNames(contractId, updated);
      setEditingName(null);
      setEditValue("");
    },
    [contractId, editValue, names],
  );

  const cancelEditing = useCallback(() => {
    setEditingName(null);
    setEditValue("");
  }, []);

  /* ── Filter/Sort helpers ──────────────────────────────────────────────── */
  function hasActiveFilters(): boolean {
    return (
      filters.shareRange !== "all" ||
      filters.paymentStatus !== "all" ||
      search !== ""
    );
  }

  function clearAllFilters() {
    setSearchInput("");
    setSearch("");
    setFilters({ shareRange: "all", paymentStatus: "all" });
  }

  /* ── Compute filtered & sorted list (must be before render guards for hooks) ── */
  const searchLower = search.toLowerCase();
  const filtered = useMemo(() => {
    return collaborators
      .filter((c) => {
        // Share range filter
        if (!matchesShareRange(c.basisPoints, filters.shareRange)) return false;
        // Payment status filter
        if (paymentData && filters.paymentStatus !== "all") {
          const payoutCount = paymentData.get(c.address) ?? 0;
          if (filters.paymentStatus === "paid" && payoutCount === 0) return false;
          if (filters.paymentStatus === "unpaid" && payoutCount > 0) return false;
        }
        // Search filter: address + name
        if (searchLower) {
          const name = names.get(c.address);
          const matchesAddress = c.address.toLowerCase().includes(searchLower);
          const matchesName = name
            ? name.toLowerCase().includes(searchLower)
            : false;
          if (!matchesAddress && !matchesName) return false;
        }
        return true;
      })
      .sort((a, b) =>
        sort === "address"
          ? a.address.localeCompare(b.address)
          : b.basisPoints - a.basisPoints,
      );
  }, [collaborators, filters, paymentData, searchLower, names, sort]);

  const isFiltered = hasActiveFilters();

  const getExportItems = useCallback((): CollaboratorExportItem[] => {
    return filtered.map((c) => {
      const name = names.get(c.address);
      const tier = tierData?.get(c.address);
      const payoutCount = paymentData?.get(c.address);
      let paymentStatus: "Paid" | "Unpaid" | "Unknown" = "Unknown";
      if (paymentData !== null) {
        paymentStatus = (payoutCount ?? 0) > 0 ? "Paid" : "Unpaid";
      }
      return {
        address: c.address,
        name: name || undefined,
        basisPoints: c.basisPoints,
        sharePercentage: +(c.basisPoints / 100).toFixed(2),
        tier: tier || undefined,
        paymentStatus,
        payoutCount: payoutCount ?? 0,
      };
    });
  }, [filtered, names, tierData, paymentData]);

  const handleExportCSV = useCallback(() => {
    setExportMenuOpen(false);
    const items = getExportItems();
    const csv = buildCollaboratorsCSV(items);
    const filename = buildExportFilename("collaborators", "csv", contractId);
    downloadCSV(csv, filename);
  }, [getExportItems, contractId]);

  const handleExportJSON = useCallback(() => {
    setExportMenuOpen(false);
    const items = getExportItems();
    const json = buildCollaboratorsJSON(items, {
      contractId,
      activeFilters: {
        shareRange: filters.shareRange,
        paymentStatus: filters.paymentStatus,
        searchQuery: search || undefined,
        isFiltered,
      },
    });
    const filename = buildExportFilename("collaborators", "json", contractId);
    downloadJSON(json, filename);
  }, [getExportItems, contractId, filters, search, isFiltered]);

  /* ── Render guards ──────────────────────────────────────────────────── */
  if (!contractId) return null;
  if (loading)
    return (
      <div className="card">
        <span className="badge">Collaborators</span>
        <span className="sr-only">Loading collaborators…</span>
        <TableSkeleton rows={5} columns={3} label="Loading collaborators…" />
      </div>
    );
  if (error)
    return (
      <div className="card status error" role="alert" data-testid="collaborators-error">
        <p>{error}</p>
        <button
          type="button"
          className="retry-btn"
          onClick={() => setRetryCount((n) => n + 1)}
        >
          Retry
        </button>
      </div>
    );
  if (!collaborators.length)
    return (
      <div className="card">
        <span className="badge">Collaborators</span>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
          No collaborators found. Initialize the contract to add collaborators.
        </p>
      </div>
    );

  const filterChips: { label: string; onRemove: () => void }[] = [];

  if (filters.shareRange !== "all") {
    filterChips.push({
      label: SHARE_RANGE_LABELS[filters.shareRange],
      onRemove: () => setFilters((prev) => ({ ...prev, shareRange: "all" })),
    });
  }

  if (filters.paymentStatus !== "all") {
    filterChips.push({
      label: PAYMENT_STATUS_LABELS[filters.paymentStatus],
      onRemove: () => setFilters((prev) => ({ ...prev, paymentStatus: "all" })),
    });
  }

  if (search) {
    filterChips.push({
      label: `"${search}"`,
      onRemove: () => {
        setSearchInput("");
        setSearch("");
      },
    });
  }


  return (
    <div className="card collab-table-card">
      <span className="badge">Collaborators</span>
      <CollaboratorAllocationChart collaborators={collaborators} />

      {/* ── Search bar ───────────────────────────────────────────────── */}
      <div className="collab-search-bar">
        <span className="collab-search-icon" aria-hidden="true">
          🔍
        </span>
        <input
          placeholder="Search by address or name…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          aria-label="Search collaborators"
        />
        {searchInput && (
          <button
            type="button"
            className="collab-search-clear"
            onClick={() => {
              setSearchInput("");
              setSearch("");
            }}
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      {/* ── Filter bar ────────────────────────────────────────────────── */}
      <div className="collab-filter-bar">
        <div className="collab-filter-group">
          <span className="collab-filter-label">Share</span>
          <select
            className="collab-filter-select"
            value={filters.shareRange}
            onChange={(e) =>
              setFilters((prev) => ({
                ...prev,
                shareRange: e.target.value as ShareRange,
              }))
            }
            aria-label="Filter by share percentage"
          >
            <option value="all">All shares</option>
            <option value="gt10">&gt; 10%</option>
            <option value="r5to10">5% – 10%</option>
            <option value="r1to5">1% – 5%</option>
            <option value="lt1">&lt; 1%</option>
          </select>
        </div>

        <div className="collab-filter-group">
          <span className="collab-filter-label">Status</span>
          <select
            className="collab-filter-select"
            value={filters.paymentStatus}
            disabled={paymentData === null}
            title={
              paymentData === null
                ? "Payment data unavailable — connect wallet and fetch analytics to enable"
                : undefined
            }
            onChange={(e) =>
              setFilters((prev) => ({
                ...prev,
                paymentStatus: e.target.value as PaymentStatus,
              }))
            }
            aria-label="Filter by payment status"
          >
            <option value="all">All statuses</option>
            <option value="paid">Paid</option>
            <option value="unpaid">Unpaid</option>
          </select>
          {paymentData === null && (
            <span
              className="collab-filter-hint"
              title="Payment status data is not yet available"
            >
              ⓘ
            </span>
          )}
        </div>

        <div className="collab-filter-group">
          <button
            className={`collab-sort-btn${sort === "address" ? " collab-sort-btn--active" : ""}`}
            onClick={() => setSort("address")}
          >
            A–Z
          </button>
          <button
            className={`collab-sort-btn${sort === "share" ? " collab-sort-btn--active" : ""}`}
            onClick={() => setSort("share")}
          >
            Share ↓
          </button>
        </div>

        {/* ── Export dropdown (#896) ──────────────────────────────────── */}
        <div className="collab-export-dropdown" data-testid="collab-export-dropdown">
          <button
            type="button"
            className="collab-export-btn"
            onClick={() => setExportMenuOpen((open) => !open)}
            aria-haspopup="true"
            aria-expanded={exportMenuOpen}
            aria-label="Export collaborator data"
          >
            ⬇️ Export {isFiltered ? `(${filtered.length})` : ""}
          </button>
          {exportMenuOpen && (
            <div className="collab-export-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={handleExportCSV}
                data-testid="export-collaborators-csv"
              >
                📄 Export as CSV
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={handleExportJSON}
                data-testid="export-collaborators-json"
              >
                📋 Export as JSON
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Active filter chips ───────────────────────────────────────── */}
      {filterChips.length > 0 && (
        <div className="collab-active-filters">
          {filterChips.map((chip) => (
            <span className="collab-filter-chip" key={chip.label}>
              {chip.label}
              <button
                type="button"
                className="collab-filter-chip-remove"
                onClick={chip.onRemove}
                aria-label={`Remove filter: ${chip.label}`}
              >
                ✕
              </button>
            </span>
          ))}
          <div className="collab-filter-actions">
            <button
              type="button"
              className="collab-clear-filters"
              onClick={clearAllFilters}
            >
              Clear all
            </button>
          </div>
        </div>
      )}

      {/* ── Result count ──────────────────────────────────────────────── */}
      <div className="collab-result-count">
        <span className="collab-result-count-text">
          Showing{" "}
          <span
            className={`collab-result-count-badge${isFiltered ? " collab-result-count-badge--filtered" : ""}`}
          >
            {filtered.length}
          </span>{" "}
          of {collaborators.length} collaborator
          {collaborators.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* ── Empty results message ─────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="collab-no-results">
          <span className="collab-no-results-icon" aria-hidden="true">
            🔎
          </span>
          <p>No collaborators match your current filters.</p>
          <p style={{ fontSize: "0.75rem" }}>
            Try adjusting your search or filter criteria.
          </p>
          <button
            type="button"
            className="collab-no-results-reset"
            onClick={clearAllFilters}
          >
            Reset all filters
          </button>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Address</th>
              <th>Tier</th>
              <th style={{ textAlign: "right" }}>Share</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const tier = tierData?.get(c.address) ?? "regular";
              return (
                <tr key={c.address}>
                  <td>
                    {/* Editable name */}
                    {editingName === c.address ? (
                      <input
                        className="collab-name-input"
                        value={editValue}
                        autoFocus
                        placeholder="Name or note…"
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => commitName(c.address)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitName(c.address);
                          if (e.key === "Escape") cancelEditing();
                        }}
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Edit collaborator name"
                      />
                    ) : (
                      <span
                        className="collab-name-display"
                        onClick={() => startEditing(c.address)}
                        title="Click to add a name"
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ")
                            startEditing(c.address);
                        }}
                      >
                        {names.has(c.address) ? (
                          <span className="collab-name-text">
                            {names.get(c.address)}
                          </span>
                        ) : (
                          <span className="collab-name-text collab-name-text--unnamed">
                            {c.address.slice(0, 8)}...{c.address.slice(-6)}
                          </span>
                        )}
                        <span
                          className="collab-name-edit-icon"
                          aria-hidden="true"
                        >
                          ✎
                        </span>
                      </span>
                    )}

                    {/* Copy address button */}
                    <button
                      className={`copy-btn-sm${copied === c.address ? " copied" : ""}`}
                      onClick={() => copyAddress(c.address)}
                      title={
                        copied === c.address ? "Address copied" : "Copy address"
                      }
                      aria-label={
                        copied === c.address
                          ? "Address copied"
                          : "Copy collaborator address"
                      }
                    >
                      {copied === c.address ? "✓" : "⧉"}
                    </button>
                  </td>
                  <td>
                    <span
                      className={`tier-badge tier-badge--${tier}`}
                      title={tier}
                    >
                      {tier === "vip"
                        ? "⭐ VIP"
                        : tier === "trial"
                          ? "🔹 Trial"
                          : "Regular"}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <span>{(c.basisPoints / 100).toFixed(2)}%</span>
                    <div
                      className="share-bar"
                      style={{ width: `${c.basisPoints / 100}%` }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
