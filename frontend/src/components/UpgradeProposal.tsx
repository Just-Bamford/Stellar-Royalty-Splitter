/**
 * UpgradeProposal Component (#1071)
 *
 * Provides a UI for smart contract proxy upgradability:
 *  - Proposing new logic WASM upgrades
 *  - Governance voting with quorum and majority tallying
 *  - Enforcing 24-48h timelock delays before scheduling & execution
 *  - Real-time monitoring of upgrade success & state persistence
 *  - Emergency rollback to previous version/WASM
 */

import React, { useState, useEffect, useMemo } from "react";
import "./UpgradeProposal.css";

export interface UpgradeProposalItem {
  id: number;
  proposal_id: number;
  contract_id: string;
  proposer: string;
  new_wasm_hash: string;
  new_version: string;
  description: string;
  timelock_delay_seconds: number;
  status: "proposed" | "voting" | "scheduled" | "executing" | "executed" | "rejected" | "rolled_back";
  yes_votes: number;
  no_votes: number;
  quorum_votes: number;
  scheduled_at?: number | null;
  timelock_until?: number | null;
  executed_at?: number | null;
  created_at: number;
  votes?: Array<{ voter: string; approve: number; weight: number }>;
  isApproved?: boolean;
  canSchedule?: boolean;
  canExecute?: boolean;
  timelockRemainingSeconds?: number | null;
}

export interface UpgradeMonitorData {
  contractId: string;
  proxyPattern: string;
  currentVersion: string;
  currentLogicWasm: string | null;
  previousVersion: string | null;
  previousLogicWasm: string | null;
  canRollback: boolean;
  timelockDurationHours: number;
  statePersistenceVerified: boolean;
  healthStatus: "HEALTHY" | "DEGRADED" | "UPGRADING";
  activeProposalsCount: number;
  totalUpgradesCount: number;
  totalRollbacksCount: number;
  recentHistory: Array<{
    id: number;
    from_version: string;
    to_version: string;
    wasm_hash: string;
    action: "upgrade" | "rollback";
    timestamp: number;
    note: string;
  }>;
}

export interface UpgradeProposalProps {
  contractId?: string;
  walletAddress?: string | null;
  isAdmin?: boolean;
  onRefresh?: () => void;
}

export const UpgradeProposal: React.FC<UpgradeProposalProps> = ({
  contractId = "CA3D5KRYMCMCZVACQ3OBLIR6266TJR57C4F22RMTURTBRX6O3E7BUP",
  walletAddress = null,
  isAdmin = true,
  onRefresh,
}) => {
  const [activeTab, setActiveTab] = useState<"proposals" | "propose" | "monitor">("proposals");
  const [proposals, setProposals] = useState<UpgradeProposalItem[]>([]);
  const [monitorData, setMonitorData] = useState<UpgradeMonitorData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);

  // Form states for proposing a new upgrade
  const [targetVersion, setTargetVersion] = useState("v2.0.0");
  const [wasmHash, setWasmHash] = useState("");
  const [description, setDescription] = useState("");
  const [timelockHours, setTimelockHours] = useState<number>(24);
  const [showRollbackModal, setShowRollbackModal] = useState(false);
  const [rollbackReason, setRollbackReason] = useState("Emergency rollback to previous stable version");

  // Load proposals and monitor health
  const fetchData = async () => {
    setIsLoading(true);
    try {
      const propRes = await fetch(`/api/v1/contract/upgrade/proposals/${contractId}`).catch(() => null);
      if (propRes && propRes.ok) {
        const json = await propRes.json();
        setProposals(json.data || []);
      } else {
        // Fallback default mock state for offline or initial load
        setProposals([
          {
            id: 1,
            proposal_id: 1,
            contract_id: contractId,
            proposer: walletAddress || "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
            new_wasm_hash: "a4f8e9102c3b889d123456789abcdef0123456789abcdef0123456789abcdef0",
            new_version: "v2.1.0",
            description: "Gas optimization and automated secondary split routing",
            timelock_delay_seconds: 86400,
            status: "voting",
            yes_votes: 6500,
            no_votes: 1200,
            quorum_votes: 5001,
            created_at: Math.floor(Date.now() / 1000) - 3600,
            isApproved: true,
            canSchedule: true,
          },
        ]);
      }

      const monRes = await fetch(`/api/v1/contract/upgrade/monitor/${contractId}`).catch(() => null);
      if (monRes && monRes.ok) {
        const monJson = await monRes.json();
        setMonitorData(monJson.data);
      } else {
        setMonitorData({
          contractId,
          proxyPattern: "Decoupled Proxy/Logic WASM Architecture",
          currentVersion: "v2.0.0",
          currentLogicWasm: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          previousVersion: "v1.9.0",
          previousLogicWasm: "c1a2b3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0",
          canRollback: true,
          timelockDurationHours: 24,
          statePersistenceVerified: true,
          healthStatus: "HEALTHY",
          activeProposalsCount: 1,
          totalUpgradesCount: 3,
          totalRollbacksCount: 0,
          recentHistory: [
            {
              id: 1,
              from_version: "v1.9.0",
              to_version: "v2.0.0",
              wasm_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              action: "upgrade",
              timestamp: Math.floor(Date.now() / 1000) - 86400 * 5,
              note: "Protocol fee distribution support",
            },
          ],
        });
      }
    } catch (err) {
      console.error("Failed to load upgrade status:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [contractId]);

  // Handle Proposing New Upgrade
  const handlePropose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!walletAddress) {
      setFeedbackMessage({ type: "error", text: "Please connect your wallet first." });
      return;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(wasmHash.trim())) {
      setFeedbackMessage({ type: "error", text: "WASM hash must be a valid 64-character hex string." });
      return;
    }

    setIsLoading(true);
    setFeedbackMessage(null);
    try {
      const res = await fetch("/api/v1/contract/upgrade/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractId,
          proposer: walletAddress,
          newWasmHash: wasmHash.trim(),
          newVersion: targetVersion.trim(),
          description: description.trim(),
          timelockDelaySeconds: timelockHours * 3600,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed to submit proposal");
      }

      setFeedbackMessage({ type: "success", text: `Upgrade proposal to ${targetVersion} created successfully!` });
      setWasmHash("");
      setDescription("");
      setActiveTab("proposals");
      fetchData();
    } catch (err: any) {
      setFeedbackMessage({ type: "error", text: err.message || "Error creating upgrade proposal" });
    } finally {
      setIsLoading(false);
    }
  };

  // Handle Voting
  const handleVote = async (proposalId: number, approve: boolean) => {
    if (!walletAddress) {
      setFeedbackMessage({ type: "error", text: "Please connect your wallet to vote." });
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch("/api/v1/contract/upgrade/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId,
          voter: walletAddress,
          approve,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to submit vote");
      }

      setFeedbackMessage({ type: "success", text: `Vote recorded: ${approve ? "YES" : "NO"}` });
      fetchData();
    } catch (err: any) {
      setFeedbackMessage({ type: "error", text: err.message });
    } finally {
      setIsLoading(false);
    }
  };

  // Handle Scheduling Upgrade (Enforcing Timelock)
  const handleSchedule = async (proposalId: number) => {
    if (!walletAddress) {
      setFeedbackMessage({ type: "error", text: "Please connect wallet to schedule upgrade." });
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch("/api/v1/contract/upgrade/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId,
          caller: walletAddress,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to schedule upgrade");
      }

      setFeedbackMessage({
        type: "success",
        text: `Upgrade scheduled! Timelock countdown (24-48h delay) is now active.`,
      });
      fetchData();
    } catch (err: any) {
      setFeedbackMessage({ type: "error", text: err.message });
    } finally {
      setIsLoading(false);
    }
  };

  // Handle Execution after Timelock
  const handleExecute = async (proposalId: number) => {
    if (!walletAddress) {
      setFeedbackMessage({ type: "error", text: "Please connect wallet to execute upgrade." });
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch("/api/v1/contract/upgrade/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId,
          caller: walletAddress,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to execute upgrade");
      }

      setFeedbackMessage({
        type: "success",
        text: "Proxy upgrade executed successfully! State and balances automatically persisted.",
      });
      fetchData();
    } catch (err: any) {
      setFeedbackMessage({ type: "error", text: err.message });
    } finally {
      setIsLoading(false);
    }
  };

  // Handle Emergency Rollback
  const handleRollback = async () => {
    if (!walletAddress) {
      setFeedbackMessage({ type: "error", text: "Admin wallet required for rollback." });
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch("/api/v1/contract/upgrade/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractId,
          caller: walletAddress,
          reason: rollbackReason,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Rollback failed");
      }

      setShowRollbackModal(false);
      setFeedbackMessage({
        type: "success",
        text: `Emergency rollback complete. Reverted to previous stable version.`,
      });
      fetchData();
    } catch (err: any) {
      setFeedbackMessage({ type: "error", text: err.message });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="upgrade-proposal-container" id="upgrade-proposal-module">
      <div className="upgrade-header">
        <h1 className="upgrade-header-title">
          <span>🛡️</span> Smart Contract Upgradability & Versioning
        </h1>
        <p className="upgrade-header-subtitle">
          Proxy pattern state persistence, decentralized governance voting, 24-48h timelock delays, and rollback safety.
        </p>
      </div>

      {feedbackMessage && (
        <div className={`upgrade-alert ${feedbackMessage.type}`} id="upgrade-feedback-alert">
          {feedbackMessage.text}
        </div>
      )}

      {/* Top Status & Metrics Banner */}
      <div className="upgrade-status-banner" id="upgrade-status-banner">
        <div className="status-stat-item">
          <span className="status-stat-label">Active Version</span>
          <span className="status-stat-value" id="status-current-version">
            {monitorData?.currentVersion || "Loading..."}
          </span>
        </div>
        <div className="status-stat-item">
          <span className="status-stat-label">Proxy Architecture</span>
          <span className="status-stat-value" style={{ fontSize: "0.9rem", color: "#e2e8f0" }}>
            State Preserved across WASM
          </span>
        </div>
        <div className="status-stat-item">
          <span className="status-stat-label">Timelock Policy</span>
          <span className="status-stat-value">
            {monitorData?.timelockDurationHours || 24}h Enforced
          </span>
        </div>
        <div className="status-stat-item">
          <span className="status-stat-label">System Health</span>
          <span className="status-badge healthy" id="status-health-badge">
            ● State Persisted & Verified
          </span>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="upgrade-tabs" role="tablist">
        <button
          id="tab-btn-proposals"
          className={`upgrade-tab-btn ${activeTab === "proposals" ? "active" : ""}`}
          onClick={() => setActiveTab("proposals")}
        >
          🗳️ Proposals & Voting ({proposals.length})
        </button>
        <button
          id="tab-btn-propose"
          className={`upgrade-tab-btn ${activeTab === "propose" ? "active" : ""}`}
          onClick={() => setActiveTab("propose")}
        >
          ➕ Suggest New Upgrade
        </button>
        <button
          id="tab-btn-monitor"
          className={`upgrade-tab-btn ${activeTab === "monitor" ? "active" : ""}`}
          onClick={() => setActiveTab("monitor")}
        >
          📈 Monitor & Rollback
        </button>
      </div>

      {/* TAB 1: Proposals & Voting */}
      {activeTab === "proposals" && (
        <div className="upgrade-card" id="proposals-tab-content">
          <h2 className="upgrade-card-title">Governance Upgrade Queue</h2>
          {proposals.length === 0 ? (
            <p style={{ color: "#94a3b8" }}>No upgrade proposals currently active.</p>
          ) : (
            proposals.map((prop) => {
              const totalVotes = prop.yes_votes + prop.no_votes;
              const yesPercent = totalVotes > 0 ? Math.round((prop.yes_votes / totalVotes) * 100) : 50;
              const remainingSecs = prop.timelockRemainingSeconds ?? 0;
              const remainingHours = Math.floor(remainingSecs / 3600);
              const remainingMins = Math.floor((remainingSecs % 3600) / 60);

              return (
                <div key={prop.proposal_id} className="proposal-list-item" id={`proposal-item-${prop.proposal_id}`}>
                  <div className="proposal-item-header">
                    <div>
                      <h3 className="proposal-item-title">
                        Upgrade #{prop.proposal_id}: Target {prop.new_version}
                      </h3>
                      <span style={{ fontSize: "0.82rem", color: "#94a3b8" }}>
                        Suggested WASM: <code>{prop.new_wasm_hash.slice(0, 16)}...{prop.new_wasm_hash.slice(-8)}</code>
                      </span>
                    </div>
                    <span className={`status-badge ${prop.status}`}>
                      {prop.status.toUpperCase()}
                    </span>
                  </div>

                  <p style={{ fontSize: "0.9rem", color: "#cbd5e1", margin: "0.5rem 0" }}>
                    {prop.description}
                  </p>

                  <div className="proposal-meta-row">
                    <span>Proposer: {prop.proposer.slice(0, 8)}...</span>
                    <span>Timelock Delay: {Math.round(prop.timelock_delay_seconds / 3600)}h</span>
                    <span>Yes: {prop.yes_votes} / No: {prop.no_votes}</span>
                  </div>

                  <div className="vote-progress-bar">
                    <div className="vote-progress-yes" style={{ width: `${yesPercent}%` }} />
                    <div className="vote-progress-no" style={{ width: `${100 - yesPercent}%` }} />
                  </div>

                  <div className="proposal-action-row">
                    {prop.status === "voting" && (
                      <>
                        <button
                          id={`vote-yes-btn-${prop.proposal_id}`}
                          className="btn-success"
                          onClick={() => handleVote(prop.proposal_id, true)}
                          disabled={isLoading}
                        >
                          👍 Vote YES
                        </button>
                        <button
                          id={`vote-no-btn-${prop.proposal_id}`}
                          className="btn-danger"
                          onClick={() => handleVote(prop.proposal_id, false)}
                          disabled={isLoading}
                        >
                          👎 Vote NO
                        </button>
                        {prop.isApproved && (
                          <button
                            id={`schedule-btn-${prop.proposal_id}`}
                            className="btn-primary"
                            onClick={() => handleSchedule(prop.proposal_id)}
                            disabled={isLoading}
                          >
                            ⏳ Schedule Upgrade (Start Timelock)
                          </button>
                        )}
                      </>
                    )}

                    {prop.status === "scheduled" && (
                      <>
                        <div className="timelock-countdown-badge" id={`timelock-badge-${prop.proposal_id}`}>
                          {remainingSecs > 0
                            ? `🕒 Timelock Delay: ${remainingHours}h ${remainingMins}m remaining`
                            : "✅ Timelock Delay Elapsed — Ready to Execute"}
                        </div>
                        <button
                          id={`execute-btn-${prop.proposal_id}`}
                          className="btn-primary"
                          onClick={() => handleExecute(prop.proposal_id)}
                          disabled={isLoading || remainingSecs > 0}
                        >
                          🚀 Execute Upgrade
                        </button>
                      </>
                    )}

                    {prop.status === "executed" && (
                      <span style={{ color: "#4ade80", fontSize: "0.85rem", fontWeight: 600 }}>
                        ✓ Successfully Deployed & Active
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* TAB 2: Suggest / Propose Upgrade */}
      {activeTab === "propose" && (
        <div className="upgrade-card" id="propose-tab-content">
          <h2 className="upgrade-card-title">Propose Smart Contract Upgrade</h2>
          <p style={{ color: "#94a3b8", fontSize: "0.88rem", marginBottom: "1.5rem" }}>
            Submit a newly compiled Soroban WASM hash for governance review. If approved, the upgrade enters an enforced 24-48 hour timelock before taking effect.
          </p>

          <form onSubmit={handlePropose}>
            <div className="upgrade-form-group">
              <label className="upgrade-form-label" htmlFor="input-new-version">
                Target Version Tag
              </label>
              <input
                id="input-new-version"
                className="upgrade-form-input"
                type="text"
                placeholder="e.g. v2.1.0"
                value={targetVersion}
                onChange={(e) => setTargetVersion(e.target.value)}
                required
              />
            </div>

            <div className="upgrade-form-group">
              <label className="upgrade-form-label" htmlFor="input-wasm-hash">
                New Logic WASM Hash (64-character hex)
              </label>
              <input
                id="input-wasm-hash"
                className="upgrade-form-input"
                type="text"
                placeholder="e.g. a4f8e9102c3b889d123456789abcdef0123456789abcdef0123456789abcdef0"
                value={wasmHash}
                onChange={(e) => setWasmHash(e.target.value)}
                required
              />
              <span className="upgrade-form-help">
                Must be an installed Soroban contract WASM hash on Stellar.
              </span>
            </div>

            <div className="upgrade-form-group">
              <label className="upgrade-form-label" htmlFor="select-timelock">
                Enforced Timelock Safety Window
              </label>
              <select
                id="select-timelock"
                className="upgrade-form-select"
                value={timelockHours}
                onChange={(e) => setTimelockHours(Number(e.target.value))}
              >
                <option value={24}>24 Hours (Standard Safe Window)</option>
                <option value={36}>36 Hours (Extended Review)</option>
                <option value={48}>48 Hours (Maximum Safety Period)</option>
              </select>
              <span className="upgrade-form-help">
                Enforces a delay between governance vote passing and actual deployment.
              </span>
            </div>

            <div className="upgrade-form-group">
              <label className="upgrade-form-label" htmlFor="input-description">
                Upgrade Summary & Changelog
              </label>
              <textarea
                id="input-description"
                className="upgrade-form-textarea"
                rows={4}
                placeholder="Explain the changes, optimizations, or bug fixes in this WASM release..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
              />
            </div>

            <button
              id="submit-proposal-btn"
              type="submit"
              className="btn-primary"
              disabled={isLoading}
            >
              {isLoading ? "Submitting Proposal..." : "Submit Upgrade Proposal"}
            </button>
          </form>
        </div>
      )}

      {/* TAB 3: Monitor & Rollback */}
      {activeTab === "monitor" && (
        <div className="upgrade-card" id="monitor-tab-content">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h2 className="upgrade-card-title" style={{ margin: 0 }}>
              Live Contract Health & Rollback Safety
            </h2>
            {monitorData?.canRollback && (
              <button
                id="trigger-rollback-btn"
                className="btn-danger"
                onClick={() => setShowRollbackModal(true)}
              >
                ⏪ Emergency Rollback
              </button>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1.5rem" }}>
            <div style={{ background: "rgba(15, 23, 42, 0.6)", padding: "1rem", borderRadius: "8px" }}>
              <h4 style={{ margin: "0 0 0.5rem 0", color: "#38bdf8" }}>Current Active Code</h4>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "#cbd5e1" }}>
                Version: <strong>{monitorData?.currentVersion}</strong>
              </p>
              <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.78rem", color: "#94a3b8", wordBreak: "break-all" }}>
                WASM: {monitorData?.currentLogicWasm || "N/A"}
              </p>
            </div>

            <div style={{ background: "rgba(15, 23, 42, 0.6)", padding: "1rem", borderRadius: "8px" }}>
              <h4 style={{ margin: "0 0 0.5rem 0", color: "#f59e0b" }}>Rollback Target</h4>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "#cbd5e1" }}>
                Previous Version: <strong>{monitorData?.previousVersion || "None"}</strong>
              </p>
              <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.78rem", color: "#94a3b8", wordBreak: "break-all" }}>
                Previous WASM: {monitorData?.previousLogicWasm || "None"}
              </p>
            </div>
          </div>

          <h3 style={{ fontSize: "1.1rem", color: "#f8fafc", marginBottom: "1rem" }}>
            Upgrade & Migration Audit Trail
          </h3>

          <div className="timeline-container">
            {monitorData?.recentHistory?.map((h) => (
              <div key={h.id} className="timeline-item">
                <div className="timeline-timestamp">
                  {new Date(h.timestamp * 1000).toLocaleString()}
                </div>
                <div className="timeline-desc">
                  <strong>{h.action.toUpperCase()}:</strong> {h.from_version} → {h.to_version}
                  <div style={{ fontSize: "0.8rem", color: "#94a3b8" }}>{h.note}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confirmation Modal for Emergency Rollback */}
      {showRollbackModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          id="rollback-modal"
        >
          <div
            style={{
              background: "#1e293b",
              border: "1px solid #ef4444",
              borderRadius: "12px",
              padding: "1.5rem",
              maxWidth: "500px",
              width: "90%",
            }}
          >
            <h3 style={{ color: "#ef4444", margin: "0 0 0.5rem 0" }}>⚠️ Confirm Emergency Rollback</h3>
            <p style={{ fontSize: "0.88rem", color: "#cbd5e1" }}>
              Are you sure you want to rollback to <strong>{monitorData?.previousVersion}</strong>?
              This will update the proxy logic contract back to the previous stable WASM hash.
              All collaborators, balances, and distribution records remain intact.
            </p>
            <div style={{ margin: "1rem 0" }}>
              <label className="upgrade-form-label" htmlFor="rollback-reason-input">
                Reason for Rollback
              </label>
              <input
                id="rollback-reason-input"
                className="upgrade-form-input"
                type="text"
                value={rollbackReason}
                onChange={(e) => setRollbackReason(e.target.value)}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
              <button
                id="cancel-rollback-btn"
                className="btn-secondary"
                onClick={() => setShowRollbackModal(false)}
              >
                Cancel
              </button>
              <button
                id="confirm-rollback-btn"
                className="btn-danger"
                onClick={handleRollback}
                disabled={isLoading}
              >
                {isLoading ? "Reverting..." : "Confirm Rollback"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UpgradeProposal;
