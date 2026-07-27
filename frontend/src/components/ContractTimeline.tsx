// #585 Contract Activity Timeline
import { useState, useEffect, useCallback } from "react";
import { api, TransactionRecord, AuditLogEntry } from "../api";
import { Skeleton } from "./Skeleton";
import { CopyButton } from "./CopyButton";
import "./ContractTimeline.css";

interface ContractTimelineProps {
  contractId: string;
}

type EventType = "all" | "initialize" | "distribute" | "secondary" | "audit";

interface TimelineEvent {
  id: string;
  kind: "transaction" | "audit";
  type: string;
  status?: string;
  timestamp: string;
  initiator?: string;
  txHash?: string | null;
  amount?: string | null;
  payoutCount?: number;
  details?: string | null;
  action?: string;
}

const TYPE_ICONS: Record<string, string> = {
  initialize: "🚀",
  distribute: "💰",
  secondary_royalty: "🏷️",
  secondary_distribute: "🔄",
  audit: "📋",
  default: "📌",
};

const TYPE_LABELS: Record<string, string> = {
  initialize: "Initialize",
  distribute: "Distribution",
  secondary_royalty: "Secondary Sale",
  secondary_distribute: "Secondary Dist.",
  audit: "Audit Event",
};

function dotClass(type: string): string {
  if (["initialize", "distribute", "secondary_royalty", "secondary_distribute"].includes(type))
    return type;
  if (type === "audit") return "audit";
  return "default";
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const LIMIT = 20;

export const ContractTimeline: React.FC<ContractTimelineProps> = ({ contractId }) => {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<EventType>("all");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    if (!contractId) return;
    setLoading(true);
    setError(null);
    try {
      const [txRes, auditRes] = await Promise.all([
        api.getTransactionHistory(contractId, LIMIT, offset),
        api.getAuditLog(contractId, LIMIT, offset),
      ]);

      const txEvents: TimelineEvent[] = (txRes.data ?? []).map((t: TransactionRecord) => ({
        id: `tx-${t.id}`,
        kind: "transaction",
        type: t.type,
        status: t.status,
        timestamp: t.blockTime ?? t.timestamp,
        initiator: t.initiatorAddress,
        txHash: t.txHash,
        amount: t.requestedAmount,
        payoutCount: t.payoutCount,
      }));

      const auditEvents: TimelineEvent[] = (auditRes.data ?? []).map((a: AuditLogEntry) => ({
        id: `audit-${a.id}`,
        kind: "audit",
        type: "audit",
        timestamp: a.timestamp,
        initiator: a.user ?? undefined,
        action: a.action,
        details: a.details,
      }));

      // Merge and sort newest first
      const merged = [...txEvents, ...auditEvents].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );

      setEvents(merged);
      setTotal(txRes.pagination?.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load timeline");
    } finally {
      setLoading(false);
    }
  }, [contractId, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = events.filter((e) => {
    if (filter === "all") return true;
    if (filter === "audit") return e.kind === "audit";
    if (filter === "secondary") return e.type.startsWith("secondary");
    return e.type === filter;
  });

  const FILTERS: { id: EventType; label: string }[] = [
    { id: "all", label: "All" },
    { id: "initialize", label: "🚀 Init" },
    { id: "distribute", label: "💰 Distribute" },
    { id: "secondary", label: "🏷️ Secondary" },
    { id: "audit", label: "📋 Audit" },
  ];

  return (
    <div className="timeline-container">
      <div className="timeline-header">
        <h2>Contract Activity</h2>
        <div className="timeline-filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`filter-btn ${filter === f.id ? "active" : ""}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
          <button className="refresh-btn" onClick={load} title="Refresh">
            🔄
          </button>
        </div>
      </div>

      {error && <p style={{ color: "var(--color-danger, red)", marginBottom: "1rem" }}>{error}</p>}

      {loading ? (
        <div className="timeline-loading">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="timeline-skeleton-item">
              <Skeleton width="1rem" height="1rem" style={{ borderRadius: "50%", flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <Skeleton width="40%" height="0.875rem" className="mb-2" />
                <Skeleton width="70%" height="1rem" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="timeline-empty">No events found for this filter.</div>
      ) : (
        <>
          <div className="timeline">
            {filtered.map((event) => {
              const dc = dotClass(event.type);
              const icon = TYPE_ICONS[event.type] ?? TYPE_ICONS.default;
              const label = TYPE_LABELS[event.type] ?? event.action ?? event.type;

              return (
                <div key={event.id} className="timeline-item">
                  <div className={`timeline-dot ${dc}`} aria-hidden="true" />
                  <div className="timeline-card">
                    <div className="timeline-card-header">
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                        <span className={`timeline-type-badge ${dc}`}>
                          {icon} {label}
                        </span>
                        {event.status && (
                          <span className={`timeline-status-badge ${event.status}`}>
                            {event.status}
                          </span>
                        )}
                      </div>
                      <span className="timeline-time" title={new Date(event.timestamp).toLocaleString()}>
                        {timeAgo(event.timestamp)}
                      </span>
                    </div>

                    <div className="timeline-meta">
                      {event.initiator && (
                        <span className="timeline-meta-item">
                          <span className="timeline-meta-label">By:</span>
                          <code>{event.initiator.slice(0, 8)}…{event.initiator.slice(-4)}</code>
                        </span>
                      )}
                      {event.txHash && (
                        <span className="timeline-meta-item">
                          <span className="timeline-meta-label">TX:</span>
                          <code>{event.txHash.slice(0, 10)}…</code>
                          <CopyButton value={event.txHash} label="tx hash" size="sm" />
                        </span>
                      )}
                      {event.amount && (
                        <span className="timeline-meta-item">
                          <span className="timeline-meta-label">Amount:</span>
                          {event.amount}
                        </span>
                      )}
                      {typeof event.payoutCount === "number" && event.payoutCount > 0 && (
                        <span className="timeline-meta-item">
                          <span className="timeline-meta-label">Payouts:</span>
                          {event.payoutCount}
                        </span>
                      )}
                      {event.details && (
                        <span className="timeline-meta-item">
                          <span className="timeline-meta-label">Details:</span>
                          {event.details}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="timeline-pagination">
            <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0}>
              ← Newer
            </button>
            <span>
              {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
            </span>
            <button
              onClick={() => setOffset(offset + LIMIT)}
              disabled={offset + LIMIT >= total}
            >
              Older →
            </button>
          </div>
        </>
      )}
    </div>
  );
};
