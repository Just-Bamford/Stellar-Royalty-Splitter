import { useCallback, useMemo, useState } from "react";
import { api } from "../api";
import { queryClient } from "../lib/queryClient";
import { TableSkeleton } from "./Skeleton";
import CollaboratorQuickView from "./CollaboratorQuickView";
import CollaboratorComparison from "./CollaboratorComparison";
import {
  useCollaboratorSearch,
  type CollaboratorSortKey,
} from "../hooks/queries/useCollaboratorSearch";
import {
  buildCollaboratorsCSV,
  buildExportFilename,
  downloadCSV,
  type CollaboratorExportItem,
} from "../utils/export";
// Reuses BulkOperationsPanel's visual styling (`.bulk-operations-panel` /
// `.bulk-action-btn` / etc.) for the collaborator bulk-action bar below —
// see the comment above that bar for why the component itself isn't reused.
import { BulkActionToolbar } from "./BulkActionToolbar";
import { useBulkOperations } from "../hooks/useBulkOperations";
import "./BulkOperationsPanel.css";
import "./CollaboratorDirectory.css";

interface CollaboratorDirectoryProps {
  contractId: string;
  /** Wallet address of the operator performing bulk actions, used for audit attribution. */
  walletAddress?: string | null;
}

const TIER_OPTIONS: { value: "all" | "vip" | "regular" | "trial"; label: string }[] = [
  { value: "all", label: "All tiers" },
  { value: "vip", label: "VIP" },
  { value: "regular", label: "Regular" },
  { value: "trial", label: "Trial" },
];

const STATUS_OPTIONS: { value: "all" | "active" | "suspended" | "deactivated"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "deactivated", label: "Deactivated" },
];

const SORT_OPTIONS: { value: CollaboratorSortKey; label: string }[] = [
  { value: "earnings", label: "Earnings" },
  { value: "joinDate", label: "Join Date" },
  { value: "activity", label: "Last Activity" },
  { value: "share", label: "Share" },
  { value: "address", label: "Address" },
];

export default function CollaboratorDirectory({
  contractId,
  walletAddress,
}: CollaboratorDirectoryProps) {
  const [search, setSearch] = useState("");
  const [tier, setTier] = useState<"all" | "vip" | "regular" | "trial">("all");
  const [status, setStatus] = useState<"all" | "active" | "suspended" | "deactivated">("all");
  const [minEarnings, setMinEarnings] = useState("");
  const [maxEarnings, setMaxEarnings] = useState("");
  const [joinedAfter, setJoinedAfter] = useState("");
  const [joinedBefore, setJoinedBefore] = useState("");
  const [sortBy, setSortBy] = useState<CollaboratorSortKey>("earnings");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quickViewAddress, setQuickViewAddress] = useState<string | null>(null);
  const [showComparison, setShowComparison] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [showMessageForm, setShowMessageForm] = useState(false);
  const [tierChangeTarget, setTierChangeTarget] = useState<"vip" | "regular" | "trial">("vip");
  const [showTierForm, setShowTierForm] = useState(false);

  const { results, all, isLoading, isError, error, refetch } = useCollaboratorSearch(contractId, {
    search,
    tier,
    status,
    minEarnings: minEarnings ? Number(minEarnings) : undefined,
    maxEarnings: maxEarnings ? Number(maxEarnings) : undefined,
    joinedAfter: joinedAfter || undefined,
    joinedBefore: joinedBefore || undefined,
    sortBy,
    sortDirection,
  });

  const {
    progress: bulkProgress,
    statusMessage: hookStatusMessage,
    bulkSuspend: hookBulkSuspend,
    bulkUnsuspend: hookBulkUnsuspend,
    bulkChangeTier: hookBulkChangeTier,
    bulkSendMessage: hookBulkSendMessage,
  } = useBulkOperations(contractId, walletAddress);

  const selectedItems = useMemo(
    () => all.filter((c) => selected.has(c.address)),
    [all, selected],
  );

  const quickViewItem = useMemo(
    () => all.find((c) => c.address === quickViewAddress) ?? null,
    [all, quickViewAddress],
  );

  function toggleSelect(address: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      if (results.length > 0 && results.every((c) => prev.has(c.address))) {
        // All visible rows are selected — deselect just the visible ones.
        const next = new Set(prev);
        for (const c of results) next.delete(c.address);
        return next;
      }
      const next = new Set(prev);
      for (const c of results) next.add(c.address);
      return next;
    });
  }

  const allVisibleSelected = results.length > 0 && results.every((c) => selected.has(c.address));

  function clearAllFilters() {
    setSearch("");
    setTier("all");
    setStatus("all");
    setMinEarnings("");
    setMaxEarnings("");
    setJoinedAfter("");
    setJoinedBefore("");
  }

  async function invalidateDirectory() {
    await queryClient.invalidateQueries({ queryKey: ["collaborator-directory", contractId] });
    await refetch();
  }

  /* ── Bulk actions ───────────────────────────────────────────────────────
   * The backend has no dedicated bulk endpoints (out of scope per #923) —
   * each bulk action loops over the selection and calls the same
   * single-collaborator mutation the rest of the app already uses:
   *   - suspend/unsuspend  -> api.setContributorStatus (ContributorSuspension.tsx)
   *   - tier change        -> api.setContributorTier   (tiers.js / CollaboratorTable tier badges)
   *   - send message       -> api.sendNotification      (notifications "send" route)
   */
  const runBulk = useCallback(
    async (label: string, action: (address: string) => Promise<unknown>) => {
      setBulkLoading(true);
      setBulkMessage(null);
      const addresses = Array.from(selected);
      const failures: string[] = [];
      for (const address of addresses) {
        try {
          await action(address);
        } catch {
          failures.push(address);
        }
      }
      setBulkLoading(false);
      if (failures.length === 0) {
        setBulkMessage({ type: "ok", text: `${label} succeeded for ${addresses.length} collaborator(s).` });
      } else {
        setBulkMessage({
          type: "err",
          text: `${label}: ${addresses.length - failures.length} succeeded, ${failures.length} failed.`,
        });
      }
      await invalidateDirectory();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, contractId],
  );

  const handleBulkSuspend = useCallback(
    () =>
      runBulk("Suspend", (address) =>
        api.setContributorStatus(contractId, address, {
          status: "suspended",
          updatedBy: walletAddress ?? undefined,
        }),
      ),
    [runBulk, contractId, walletAddress],
  );

  const handleBulkUnsuspend = useCallback(
    () =>
      runBulk("Unsuspend", (address) =>
        api.setContributorStatus(contractId, address, {
          status: "active",
          updatedBy: walletAddress ?? undefined,
        }),
      ),
    [runBulk, contractId, walletAddress],
  );

  const handleBulkTierChange = useCallback(
    () =>
      runBulk(`Tier change to ${tierChangeTarget}`, (address) =>
        api.setContributorTier(contractId, address, tierChangeTarget),
      ).then(() => setShowTierForm(false)),
    [runBulk, contractId, tierChangeTarget],
  );

  const handleBulkSendMessage = useCallback(() => {
    if (!messageDraft.trim()) return;
    return runBulk("Send message", (address) =>
      api.sendNotification(address, "directory_message", "Message from project", messageDraft.trim()),
    ).then(() => {
      setShowMessageForm(false);
      setMessageDraft("");
    });
  }, [runBulk, messageDraft]);

  const handleBulkExport = useCallback(() => {
    const items: CollaboratorExportItem[] = selectedItems.map((c) => ({
      address: c.address,
      name: c.name,
      basisPoints: c.basisPoints,
      sharePercentage: c.sharePercentage,
      tier: c.tier,
      paymentStatus: c.status === "active" ? (c.payoutCount > 0 ? "Paid" : "Unpaid") : "Unknown",
      payoutCount: c.payoutCount,
    }));
    const csv = buildCollaboratorsCSV(items);
    const filename = buildExportFilename("collaborators-selected", "csv", contractId);
    downloadCSV(csv, filename);
  }, [selectedItems, contractId]);

  if (!contractId) return null;

  if (isLoading) {
    return (
      <div className="card collaborator-directory">
        <span className="badge">Collaborator Directory</span>
        <span className="sr-only">Loading collaborators…</span>
        <TableSkeleton rows={6} columns={5} label="Loading collaborator directory…" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="card status error" role="alert" data-testid="collaborator-directory-error">
        <p>{error instanceof Error ? error.message : "Failed to load collaborators"}</p>
        <button type="button" className="retry-btn" onClick={() => void refetch()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="card collaborator-directory" data-testid="collaborator-directory">
      <span className="badge">Collaborator Directory</span>

      {/* ── Search ─────────────────────────────────────────────────────── */}
      <div className="cd-search-bar">
        <input
          placeholder="Search by name, address, or tier…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search collaborators"
        />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <div className="cd-filter-bar">
        <div className="cd-filter-group">
          <label htmlFor="cd-tier">Tier</label>
          <select
            id="cd-tier"
            value={tier}
            onChange={(e) => setTier(e.target.value as typeof tier)}
            aria-label="Filter by tier"
          >
            {TIER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="cd-filter-group">
          <label htmlFor="cd-status">Status</label>
          <select
            id="cd-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            aria-label="Filter by status"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="cd-filter-group">
          <label htmlFor="cd-min-earnings">Min earnings</label>
          <input
            id="cd-min-earnings"
            type="number"
            inputMode="decimal"
            value={minEarnings}
            onChange={(e) => setMinEarnings(e.target.value)}
            aria-label="Minimum earnings"
            placeholder="0"
          />
        </div>

        <div className="cd-filter-group">
          <label htmlFor="cd-max-earnings">Max earnings</label>
          <input
            id="cd-max-earnings"
            type="number"
            inputMode="decimal"
            value={maxEarnings}
            onChange={(e) => setMaxEarnings(e.target.value)}
            aria-label="Maximum earnings"
            placeholder="∞"
          />
        </div>

        <div className="cd-filter-group">
          <label htmlFor="cd-joined-after">Joined after</label>
          <input
            id="cd-joined-after"
            type="date"
            value={joinedAfter}
            onChange={(e) => setJoinedAfter(e.target.value)}
            aria-label="Joined after date"
          />
        </div>

        <div className="cd-filter-group">
          <label htmlFor="cd-joined-before">Joined before</label>
          <input
            id="cd-joined-before"
            type="date"
            value={joinedBefore}
            onChange={(e) => setJoinedBefore(e.target.value)}
            aria-label="Joined before date"
          />
        </div>

        <div className="cd-filter-group">
          <label htmlFor="cd-sort-by">Sort by</label>
          <select
            id="cd-sort-by"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as CollaboratorSortKey)}
            aria-label="Sort by"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="cd-sort-direction-btn"
            onClick={() => setSortDirection((d) => (d === "asc" ? "desc" : "asc"))}
            aria-label={`Sort direction: ${sortDirection === "asc" ? "ascending" : "descending"}`}
            title={sortDirection === "asc" ? "Ascending" : "Descending"}
          >
            {sortDirection === "asc" ? "↑" : "↓"}
          </button>
        </div>

        <button type="button" className="cd-clear-filters-btn" onClick={clearAllFilters}>
          Clear all
        </button>
      </div>

      {/* ── Result count ───────────────────────────────────────────────── */}
      <div className="cd-result-count">
        Showing <span className="cd-result-count-badge">{results.length}</span> of {all.length}{" "}
        collaborator{all.length !== 1 ? "s" : ""}
      </div>

      {/* ── Bulk operations ──────────────────────────────────────────────
       * Follows the same visual pattern as BulkOperationsPanel.tsx (the
       * `.bulk-operations-panel` / `.bulk-header` / `.bulk-actions` /
       * `.bulk-action-btn` structure and CSS classes), but that component's
       * props (onBulkDistribute / onAggregatedView) are hard-coded for
       * multi-*contract* selection (Dashboard.tsx's "Distribute to All"
       * flow) and don't fit collaborator-level actions — reusing it as-is
       * would show a "Distribute to All" button that actually suspends
       * collaborators. So this renders its own action bar, matching the
       * panel's look via the same CSS classes, with correctly labeled
       * collaborator actions instead of mismatched contract ones. */}
      <div className="bulk-operations-panel" role="region" aria-label="Bulk operations">
        <div className="bulk-header">
          <span className="selected-count">
            {selected.size} collaborator{selected.size !== 1 ? "s" : ""} selected
          </span>
        </div>
        <div className="bulk-actions">
          <button
            type="button"
            className="bulk-action-btn bulk-distribute"
            onClick={() => void handleBulkSuspend()}
            disabled={selected.size === 0 || bulkLoading}
            aria-label={`Suspend ${selected.size} selected collaborators`}
          >
            {bulkLoading ? "Working…" : "Suspend Selected"}
          </button>
          <button
            type="button"
            className="bulk-action-btn"
            onClick={() => void handleBulkUnsuspend()}
            disabled={selected.size === 0 || bulkLoading}
            aria-label={`Unsuspend ${selected.size} selected collaborators`}
          >
            Unsuspend Selected
          </button>
          <button
            type="button"
            className="bulk-action-btn"
            onClick={() => setShowTierForm((v) => !v)}
            disabled={selected.size === 0 || bulkLoading}
          >
            Change Tier…
          </button>
          <button
            type="button"
            className="bulk-action-btn"
            onClick={() => setShowMessageForm((v) => !v)}
            disabled={selected.size === 0 || bulkLoading}
          >
            Send Message…
          </button>
          <button
            type="button"
            className="bulk-action-btn bulk-export"
            onClick={handleBulkExport}
            disabled={selected.size === 0 || bulkLoading}
            aria-label={`Export earnings from ${selected.size} selected collaborators`}
          >
            Export Selected (CSV)
          </button>
          <button
            type="button"
            className="bulk-action-btn bulk-aggregate"
            onClick={() => setShowComparison((v) => !v)}
            disabled={selected.size === 0 || bulkLoading}
            aria-label="Compare selected collaborators"
          >
            Compare Selected
          </button>
        </div>
      </div>

      {showTierForm && (
        <div className="cd-inline-form" data-testid="cd-tier-form">
          <select
            value={tierChangeTarget}
            onChange={(e) => setTierChangeTarget(e.target.value as typeof tierChangeTarget)}
            aria-label="New tier for selected collaborators"
          >
            <option value="vip">VIP</option>
            <option value="regular">Regular</option>
            <option value="trial">Trial</option>
          </select>
          <button type="button" onClick={() => void handleBulkTierChange()} disabled={bulkLoading}>
            Apply Tier
          </button>
        </div>
      )}

      {showMessageForm && (
        <div className="cd-inline-form" data-testid="cd-message-form">
          <textarea
            value={messageDraft}
            onChange={(e) => setMessageDraft(e.target.value)}
            placeholder="Message to send to selected collaborators…"
            aria-label="Message to send"
            rows={3}
          />
          <button
            type="button"
            onClick={() => void handleBulkSendMessage()}
            disabled={bulkLoading || !messageDraft.trim()}
          >
            Send to {selected.size} collaborator{selected.size !== 1 ? "s" : ""}
          </button>
        </div>
      )}

      {bulkMessage && (
        <p className={`cd-bulk-message cd-bulk-message--${bulkMessage.type}`} role="status">
          {bulkMessage.text}
        </p>
      )}

      {showComparison && (
        <div className="cd-comparison-section">
          <CollaboratorComparison collaborators={selectedItems} />
        </div>
      )}

      {/* ── List ───────────────────────────────────────────────────────── */}
      {results.length === 0 ? (
        <div className="cd-no-results">
          <p>No collaborators match your current filters.</p>
          <button type="button" onClick={clearAllFilters}>
            Reset all filters
          </button>
        </div>
      ) : (
        <table className="cd-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAll}
                  aria-label="Select all visible collaborators"
                />
              </th>
              <th>Address</th>
              <th>Tier</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Share</th>
              <th style={{ textAlign: "right" }}>Total Earned</th>
            </tr>
          </thead>
          <tbody>
            {results.map((c) => (
              <tr key={c.address} data-testid={`cd-row-${c.address}`}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(c.address)}
                    onChange={() => toggleSelect(c.address)}
                    aria-label={`Select ${c.address}`}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="cd-address-btn"
                    onClick={() => setQuickViewAddress(c.address)}
                    title="View profile"
                  >
                    {c.name || `${c.address.slice(0, 8)}...${c.address.slice(-6)}`}
                  </button>
                </td>
                <td>
                  <span className={`tier-badge tier-badge--${c.tier}`}>{c.tier}</span>
                </td>
                <td>
                  <span className={`cd-status-badge cd-status-badge--${c.status}`}>{c.status}</span>
                </td>
                <td style={{ textAlign: "right" }}>{c.sharePercentage.toFixed(2)}%</td>
                <td style={{ textAlign: "right" }}>{c.totalEarned.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CollaboratorQuickView collaborator={quickViewItem} onClose={() => setQuickViewAddress(null)} />
    </div>
  );
}
