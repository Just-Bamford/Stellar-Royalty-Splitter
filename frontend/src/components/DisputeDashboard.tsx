import { useMemo, useState } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import { useDisputes, type DisputeStatus } from "../hooks/queries/useDisputes";
import { DisputeDetail } from "./DisputeDetail";
import "./DisputeDashboard.css";

interface DisputeDashboardProps {
  walletAddress?: string | null;
}

const statusLabelMap: Record<DisputeStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  "clawed-back": "Clawed back",
};

export function DisputeDashboard({ walletAddress = null }: DisputeDashboardProps) {
  const { filteredDisputes, groupedDisputes, metrics, filters, setFilters, updateDisputeStatus } =
    useDisputes();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useWebSocket({
    walletAddress: walletAddress ?? "GAAAAA...",
    enabled: Boolean(walletAddress),
    onNotification: (data: unknown) => {
      const payload = data as Record<string, unknown> | null;
      const status = typeof payload?.status === "string" ? payload.status : "";
      const disputeId =
        typeof payload?.disputeId === "string"
          ? payload.disputeId
          : typeof payload?.ticketId === "string"
            ? payload.ticketId
            : null;

      if ((payload?.type === "dispute" || payload?.type === "dispute_status") && disputeId && status) {
        updateDisputeStatus(disputeId, status as DisputeStatus, payload.adminResponse as string | undefined);
      }
    },
  });

  const selectedDispute = useMemo(
    () => filteredDisputes.find((dispute) => dispute.id === selectedId) ?? null,
    [filteredDisputes, selectedId],
  );

  return (
    <div className="dispute-dashboard">
      <div className="dispute-header">
        <div>
          <div className="eyebrow">Case management</div>
          <h1>Dispute dashboard</h1>
        </div>
        <div className="live-status">
          <span className="live-dot" aria-hidden="true" />
          {walletAddress ? "Live updates" : "Demo mode"}
        </div>
      </div>

      <div className="dispute-metrics">
        <div className="metric-card">
          <span>Open disputes</span>
          <strong>{metrics.openCount}</strong>
        </div>
        <div className="metric-card">
          <span>Avg. resolution</span>
          <strong>{metrics.avgResolutionTime.toFixed(1)} d</strong>
        </div>
        <div className="metric-card">
          <span>Clawed back</span>
          <strong>${metrics.totalClawedBack.toLocaleString()}</strong>
        </div>
      </div>

      <div className="dispute-filters">
        <label>
          Status
          <select
            value={filters.status}
            onChange={(event) =>
              setFilters((current) => ({ ...current, status: event.target.value as typeof current.status }))
            }
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="clawed-back">Clawed back</option>
          </select>
        </label>

        <label>
          Minimum amount
          <input
            type="number"
            value={filters.minAmount}
            onChange={(event) =>
              setFilters((current) => ({ ...current, minAmount: event.target.value }))
            }
            placeholder="0"
          />
        </label>

        <label>
          Maximum amount
          <input
            type="number"
            value={filters.maxAmount}
            onChange={(event) =>
              setFilters((current) => ({ ...current, maxAmount: event.target.value }))
            }
            placeholder="10000"
          />
        </label>

        <label>
          Start date
          <input
            type="date"
            value={filters.startDate}
            onChange={(event) =>
              setFilters((current) => ({ ...current, startDate: event.target.value }))
            }
          />
        </label>

        <label>
          End date
          <input
            type="date"
            value={filters.endDate}
            onChange={(event) =>
              setFilters((current) => ({ ...current, endDate: event.target.value }))
            }
          />
        </label>

        <label>
          Collaborator
          <input
            type="text"
            value={filters.collaborator}
            onChange={(event) =>
              setFilters((current) => ({ ...current, collaborator: event.target.value }))
            }
            placeholder="Search collaborator"
          />
        </label>
      </div>

      <div className="dispute-groups">
        {groupedDisputes.map((group) => (
          <div key={group.status} className="dispute-group">
            <div className="group-header">
              <h2>{statusLabelMap[group.status]}</h2>
              <span>{group.items.length}</span>
            </div>

            {group.items.length === 0 ? (
              <div className="empty-group">No disputes match this status.</div>
            ) : (
              <div className="group-list">
                {group.items.map((dispute) => (
                  <button
                    type="button"
                    key={dispute.id}
                    className="dispute-item"
                    onClick={() => setSelectedId(dispute.id)}
                  >
                    <div className="dispute-item-topline">
                      <strong>{dispute.id}</strong>
                      <span className={`status-badge status-${dispute.status}`}>
                        {statusLabelMap[dispute.status]}
                      </span>
                    </div>
                    <h3>{dispute.title}</h3>
                    <p>{dispute.description}</p>
                    <div className="dispute-item-meta">
                      <span>{dispute.collaborator}</span>
                      <span>${dispute.amount.toLocaleString()}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {selectedDispute && (
        <DisputeDetail
          dispute={selectedDispute}
          onClose={() => setSelectedId(null)}
          onStatusChange={(disputeId, nextStatus, adminResponse) => {
            updateDisputeStatus(disputeId, nextStatus, adminResponse);
            setSelectedId(null);
          }}
        />
      )}
    </div>
  );
}

export default DisputeDashboard;
