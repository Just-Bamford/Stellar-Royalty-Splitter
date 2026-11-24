import { useEffect, useState, useRef, useCallback, useMemo } from "react";

import { api } from "../api";
import { useCollaborators } from "../hooks/queries/useCollaborators";
import { useAnalytics } from "../hooks/queries/useAnalytics";
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

/* ÔöÇÔöÇ Filter types ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */

type ShareRange = "all" | "gt10" | "r5to10" | "r1to5" | "lt1";
type PaymentStatus = "all" | "paid" | "unpaid";

interface ActiveFilters {
  shareRange: ShareRange;
  paymentStatus: PaymentStatus;
}

const SHARE_RANGE_LABELS: Record<ShareRange, string> = {
  all: "All shares",
  gt10: "> 10%",
  r5to10: "5 ÔÇô 10%",
  r1to5: "1 ÔÇô 5%",
  lt1: "< 1%",
};

const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  all: "All statuses",
  paid: "Paid",
  unpaid: "Unpaid",
};

/* ÔöÇÔöÇ Persistent names: single JSON blob per contract (O(1) read) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */

const getNameStorageKey = (contractId: string): string => `srs_collab_names_${contractId}`;

function loadNames(contractId: string): Map<string, string> {
  try {
    const blob = localStorage.getItem(getNameStorageKey(contractId));
    if (!blob) return new Map();
    const contractNames: Record<string, string> = JSON.parse(blob);
    return new Map(Object.entries(contractNames));
  } catch {
    return new Map();
  }
}

function saveNames(contractId: string, names: Map<string, string>) {
  try {
    const contractNames: Record<string, string> = {};
    names.forEach((value, key) => {
      contractNames[key] = value;
    });
    localStorage.setItem(getNameStorageKey(contractId), JSON.stringify(contractNames));
  } catch {
    // localStorage may be full or unavailable
  }
}

/* ÔöÇÔöÇ Share range predicate ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */

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
  const [sort, setSort] = useState<SortKey>("share");
  const [copied, setCopied] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // ── debounced search ────────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── filters ────────────────────────────────────────────────────────────────────
  const [filters, setFilters] = useState<ActiveFilters>({
    shareRange: "all",
    paymentStatus: "all",
  });

  // ── editable names ─────────────────────────────────────────────────────────────
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // ── tier data ──────────────────────────────────────────────────────────────────
  const [tierData, setTierData] = useState<Map<string, string> | null>(null);

  // ── React Query hooks ──────────────────────────────────────────────────────────
  const {
    data: collaborators = [],
    isLoading: loading,
    isError: isCollabError,
    error: collabError,
    refetch: refetchCollaborators,
  } = useCollaborators(contractId);
  const {
    data: analyticsRes,
    refetch: refetchAnalytics,
  } = useAnalytics(contractId);

  const error = isCollabError
    ? (collabError instanceof Error ? collabError.message : "Failed to load collaborators")
    : "";

  // Refetch when refreshKey changes
  useEffect(() => {
    if (!contractId) return;
    refetchCollaborators();
    refetchAnalytics();
  }, [contractId, refreshKey, refetchCollaborators, refetchAnalytics]);

  // Load names when contractId changes
  useEffect(() => {
    if (contractId) setNames(loadNames(contractId));
  }, [contractId]);

  // Fetch tiers (no React Query hook exists for this yet)
  useEffect(() => {
    if (!contractId) return;
    let cancelled = false;
    api.getContractTiers(contractId)
      .then((tiersRes) => {
        if (cancelled) return;
        const tierMap = new Map<string, string>();
        for (const tier of tiersRes.data ?? []) {
          tierMap.set(tier.walletAddress, tier.tier);
        }
        setTierData(tierMap);
      })
      .catch(() => {
        if (!cancelled) setTierData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [contractId, refreshKey]);

  // Derive payment data from analytics
  const paymentData = useMemo(() => {
    if (analyticsRes?.success && analyticsRes.data.collaboratorStats) {
      const map = new Map<string, number>();
      for (const stat of analyticsRes.data.collaboratorStats) {
        map.set(stat.address, stat.payoutCount);
      }
      return map;
    }
    return null;
  }, [analyticsRes]);

  /* ÔöÇÔöÇ Debounced search ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */
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

  /* ÔöÇÔöÇ Name editing ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */
  const startEditing = useCallback(
    (address: string) => {
      setEditingName(address);
      setEditValue(names.get(address) ?? "");
    },
    [names]
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
    [contractId, editValue, names]
  );

  const cancelEditing = useCallback(() => {
    setEditingName(null);
    setEditValue("");
  }, []);

  /* ÔöÇÔöÇ Filter/Sort helpers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */
  function hasActiveFilters(): boolean {
    return filters.shareRange !== "all" || filters.paymentStatus !== "all" || search !== "";
  }

  function clearAllFilters() {
    setSearchInput("");
    setSearch("");
    setFilters({ shareRange: "all", paymentStatus: "all" });
  }

  /* ÔöÇÔöÇ Compute filtered & sorted list (must be before render guards for hooks) ÔöÇÔöÇ */
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
          const matchesName = name ? name.toLowerCase().includes(searchLower) : false;
          if (!matchesAddress && !matchesName) return false;
        }
        return true;
      })
      .sort((a, b) =>
        sort === "address" ? a.address.localeCompare(b.address) : b.basisPoints - a.basisPoints
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

  /* ÔöÇÔöÇ Render guards ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */
  if (!contractId) return null;
  if (loading)
    return (
      <div className="card">
        <span className="badge">Collaborators</span>
        <span className="sr-only">Loading collaboratorsÔÇª</span>
        <TableSkeleton rows={5} columns={3} label="Loading collaboratorsÔÇª" />
      </div>
    );
  if (error)
    return (
      <div className="card status error" role="alert" data-testid="collaborators-error">
        <p>{error}</p>
        <button type="button" className="retry-btn" onClick={() => refetchCollaborators()}>
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

      {/* ÔöÇÔöÇ Search bar ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */}
      <div className="collab-search-bar">
        <span className="collab-search-icon" aria-hidden="true">
          ­ƒöì
        </span>
        <input
          placeholder="Search by address or nameÔÇª"
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
            Ô£ò
          </button>
        )}
      </div>

      {/* ÔöÇÔöÇ Filter bar ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */}
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
            <option value="r5to10">5% ÔÇô 10%</option>
            <option value="r1to5">1% ÔÇô 5%</option>
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
            aria-describedby={paymentData === null ? "payment-status-hint" : undefined}
          >
            <option value="all">All statuses</option>
            <option value="paid">Paid</option>
            <option value="unpaid">Unpaid</option>
          </select>
          {paymentData === null && (
            <span
              id="payment-status-hint"
              className="collab-filter-hint-text"
              aria-live="polite"
            >
              Connect wallet to enable
            </span>
          )}
          {paymentData === null && (
            <span className="collab-filter-hint" title="Payment status data is not yet available" aria-hidden="true">
              ⚘
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

        {/* ÔöÇÔöÇ Export dropdown (#896) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */}
        <div className="collab-export-dropdown" data-testid="collab-export-dropdown">
          <button
            type="button"
            className="collab-export-btn"
            onClick={() => setExportMenuOpen((open) => !open)}
            aria-haspopup="true"
            aria-expanded={exportMenuOpen}
            aria-label="Export collaborator data"
          >
            Ô¼ç´©Å Export {isFiltered ? `(${filtered.length})` : ""}
          </button>
          {exportMenuOpen && (
            <div className="collab-export-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={handleExportCSV}
                data-testid="export-collaborators-csv"
              >
                ­ƒôä Export as CSV
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={handleExportJSON}
                data-testid="export-collaborators-json"
              >
                ­ƒôï Export as JSON
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ÔöÇÔöÇ Active filter chips ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */}
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
                Ô£ò
              </button>
            </span>
          ))}
          <div className="collab-filter-actions">
            <button type="button" className="collab-clear-filters" onClick={clearAllFilters}>
              Clear all
            </button>
          </div>
        </div>
      )}

      {/* ÔöÇÔöÇ Result count ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */}
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

      {/* ÔöÇÔöÇ Empty results message ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ */}
      {filtered.length === 0 ? (
        <div className="collab-no-results">
          <span className="collab-no-results-icon" aria-hidden="true">
            ­ƒöÄ
          </span>
          <p>No collaborators match your current filters.</p>
          <p style={{ fontSize: "0.75rem" }}>Try adjusting your search or filter criteria.</p>
          <button type="button" className="collab-no-results-reset" onClick={clearAllFilters}>
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
                        placeholder="Name or noteÔÇª"
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
                          if (e.key === "Enter" || e.key === " ") startEditing(c.address);
                        }}
                      >
                        {names.has(c.address) ? (
                          <span className="collab-name-text">{names.get(c.address)}</span>
                        ) : (
                          <span className="collab-name-text collab-name-text--unnamed">
                            {c.address.slice(0, 8)}...{c.address.slice(-6)}
                          </span>
                        )}
                        <span className="collab-name-edit-icon" aria-hidden="true">
                          Ô£Ä
                        </span>
                      </span>
                    )}

                    {/* Copy address button */}
                    <button
                      className={`copy-btn-sm${copied === c.address ? " copied" : ""}`}
                      onClick={() => copyAddress(c.address)}
                      title={copied === c.address ? "Address copied" : "Copy address"}
                      aria-label={
                        copied === c.address ? "Address copied" : "Copy collaborator address"
                      }
                    >
                      {copied === c.address ? "Ô£ô" : "Ôºë"}
                    </button>
                  </td>
                  <td>
                    <span className={`tier-badge tier-badge--${tier}`} title={tier}>
                      {tier === "vip" ? "Ô¡É VIP" : tier === "trial" ? "­ƒö╣ Trial" : "Regular"}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <span>{(c.basisPoints / 100).toFixed(2)}%</span>
                    <div className="share-bar" style={{ width: `${c.basisPoints / 100}%` }} />
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
