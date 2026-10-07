import React, { useState, useMemo } from "react";
import "./GovernancePortal.css";

export type GovProposalActionType =
  | "ChangeRoyaltyRate"
  | "SetTokenFeeOverride"
  | "PauseContract"
  | "UnpauseContract"
  | "RemoveCollaborator"
  | "AllocateBudget";

export interface GovProposalActionData {
  type: GovProposalActionType;
  rate?: number;
  token?: string;
  feeBps?: number;
  collaborator?: string;
  recipient?: string;
  amount?: string;
}

export interface GovProposalItem {
  id: number;
  proposer: string;
  title: string;
  description: string;
  action: GovProposalActionData;
  yesVotes: string;
  noVotes: string;
  quorumVotes: string;
  createdAt: number;
  votingEndsAt: number;
  executed: boolean;
  rejected: boolean;
  hasVoted?: boolean;
  userVote?: boolean;
}

export interface GovernancePortalProps {
  walletAddress?: string | null;
  contractId?: string;
  totalSupply?: string;
  userBalance?: string;
  effectiveVotes?: string;
  delegate?: string | null;
  proposals?: GovProposalItem[];
  isLoading?: boolean;
  onCreateProposal?: (data: {
    title: string;
    description: string;
    action: GovProposalActionData;
    votingPeriodSeconds: number;
  }) => Promise<void>;
  onVote?: (proposalId: number, support: boolean) => Promise<void>;
  onExecute?: (proposalId: number) => Promise<void>;
  onDelegate?: (delegatee: string) => Promise<void>;
  onRevokeDelegation?: () => Promise<void>;
}

export const GovernancePortal: React.FC<GovernancePortalProps> = ({
  walletAddress = null,
  totalSupply = "0",
  userBalance = "0",
  effectiveVotes = "0",
  delegate = null,
  proposals = [],
  onCreateProposal,
  onVote,
  onExecute,
  onDelegate,
  onRevokeDelegation,
}) => {
  const [activeTab, setActiveTab] = useState<"active" | "history">("active");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDelegateModal, setShowDelegateModal] = useState(false);
  const [delegateInput, setDelegateInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Proposal Creation Form State
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [actionType, setActionType] = useState<GovProposalActionType>("ChangeRoyaltyRate");
  const [newRate, setNewRate] = useState("500");
  const [tokenAddress, setTokenAddress] = useState("");
  const [feeBps, setFeeBps] = useState("200");
  const [collabAddress, setCollabAddress] = useState("");
  const [budgetRecipient, setBudgetRecipient] = useState("");
  const [budgetAmount, setBudgetAmount] = useState("");
  const [votingDurationDays, setVotingDurationDays] = useState(3);

  const now = Math.floor(Date.now() / 1000);

  const formatAddress = (addr: string) => {
    if (!addr || addr.length < 10) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const filteredProposals = useMemo(() => {
    return proposals.filter((p) => {
      const isOpen = now < p.votingEndsAt && !p.executed && !p.rejected;
      return activeTab === "active" ? isOpen : !isOpen;
    });
  }, [proposals, activeTab, now]);

  const handleVote = async (proposalId: number, support: boolean) => {
    if (!onVote) return;
    try {
      setIsSubmitting(true);
      setActionError(null);
      await onVote(proposalId, support);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExecute = async (proposalId: number) => {
    if (!onExecute) return;
    try {
      setIsSubmitting(true);
      setActionError(null);
      await onExecute(proposalId);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateProposal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onCreateProposal) return;

    let actionData: GovProposalActionData = { type: actionType };
    if (actionType === "ChangeRoyaltyRate") {
      actionData = { type: actionType, rate: Number(newRate) };
    } else if (actionType === "SetTokenFeeOverride") {
      actionData = { type: actionType, token: tokenAddress, feeBps: Number(feeBps) };
    } else if (actionType === "RemoveCollaborator") {
      actionData = { type: actionType, collaborator: collabAddress };
    } else if (actionType === "AllocateBudget") {
      actionData = {
        type: actionType,
        token: tokenAddress,
        recipient: budgetRecipient,
        amount: budgetAmount,
      };
    }

    try {
      setIsSubmitting(true);
      setActionError(null);
      await onCreateProposal({
        title,
        description,
        action: actionData,
        votingPeriodSeconds: votingDurationDays * 86400,
      });
      setShowCreateModal(false);
      setTitle("");
      setDescription("");
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelegateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onDelegate || !delegateInput) return;
    try {
      setIsSubmitting(true);
      setActionError(null);
      await onDelegate(delegateInput);
      setShowDelegateModal(false);
      setDelegateInput("");
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRevoke = async () => {
    if (!onRevokeDelegation) return;
    try {
      setIsSubmitting(true);
      setActionError(null);
      await onRevokeDelegation();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="governance-portal">
      <div className="governance-header">
        <div>
          <div className="eyebrow">Decentralized Governance</div>
          <h1>Community Voting & Delegation</h1>
        </div>
        <div className="gov-actions-bar">
          <button
            type="button"
            className="gov-btn-primary"
            onClick={() => setShowCreateModal(true)}
            disabled={!walletAddress || BigInt(effectiveVotes || 0) === 0n}
          >
            + New Proposal
          </button>
          {delegate ? (
            <button
              type="button"
              className="gov-btn-secondary"
              onClick={handleRevoke}
              disabled={isSubmitting}
            >
              Revoke Delegation
            </button>
          ) : (
            <button
              type="button"
              className="gov-btn-secondary"
              onClick={() => setShowDelegateModal(true)}
              disabled={!walletAddress || BigInt(userBalance || 0) === 0n}
            >
              Delegate Voting Power
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div
          style={{
            background: "rgba(239, 68, 68, 0.2)",
            border: "1px solid #ef4444",
            padding: "0.75rem",
            borderRadius: "0.5rem",
            color: "#fca5a5",
          }}
        >
          {actionError}
        </div>
      )}

      <div className="governance-stats-grid">
        <div className="gov-stat-card">
          <span className="stat-label">Total Governance Supply</span>
          <span className="stat-value">{Number(totalSupply).toLocaleString()} GOV</span>
          <span className="stat-sub">1 Token = 1 Vote</span>
        </div>
        <div className="gov-stat-card">
          <span className="stat-label">Your Token Balance</span>
          <span className="stat-value">{Number(userBalance).toLocaleString()} GOV</span>
          <span className="stat-sub">
            {delegate ? `Delegated to ${formatAddress(delegate)}` : "Direct power"}
          </span>
        </div>
        <div className="gov-stat-card">
          <span className="stat-label">Your Effective Voting Power</span>
          <span className="stat-value">{Number(effectiveVotes).toLocaleString()} Votes</span>
          <span className="stat-sub">Includes delegated votes received</span>
        </div>
      </div>

      <div className="gov-nav-tabs">
        <button
          type="button"
          className={`gov-tab-btn ${activeTab === "active" ? "active" : ""}`}
          onClick={() => setActiveTab("active")}
        >
          Active Proposals
        </button>
        <button
          type="button"
          className={`gov-tab-btn ${activeTab === "history" ? "active" : ""}`}
          onClick={() => setActiveTab("history")}
        >
          Proposal History
        </button>
      </div>

      <div className="proposals-list">
        {filteredProposals.length === 0 ? (
          <div className="empty-state">
            <h3>No {activeTab === "active" ? "active" : "historical"} proposals found</h3>
            <p>
              {activeTab === "active"
                ? "There are currently no proposals up for a vote."
                : "No past executed or rejected proposals recorded."}
            </p>
          </div>
        ) : (
          filteredProposals.map((prop) => {
            const yes = BigInt(prop.yesVotes || 0);
            const no = BigInt(prop.noVotes || 0);
            const quorum = BigInt(prop.quorumVotes || 1);
            const total = yes + no;
            const yesPercent = total > 0n ? Number((yes * 100n) / (total || 1n)) : 0;
            const noPercent = total > 0n ? Number((no * 100n) / (total || 1n)) : 0;
            const isOpen = now < prop.votingEndsAt && !prop.executed && !prop.rejected;
            const isQuorumMet = total >= quorum;
            const canExecute = !isOpen && !prop.executed && !prop.rejected && isQuorumMet && yes > no;

            return (
              <div key={prop.id} className="proposal-card">
                <div className="proposal-card-header">
                  <div className="proposal-title-row">
                    <span className="proposal-id">#{prop.id}</span>
                    <h3>{prop.title}</h3>
                    <span className="gov-badge action">{prop.action.type}</span>
                    {prop.executed && (
                      <span className="gov-badge status-executed">Executed</span>
                    )}
                    {prop.rejected && (
                      <span className="gov-badge status-rejected">Rejected</span>
                    )}
                    {isOpen && <span className="gov-badge status-active">Voting Open</span>}
                    {canExecute && (
                      <span className="gov-badge status-executable">Ready to Execute</span>
                    )}
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "#9ca3af" }}>
                    Proposer: {formatAddress(prop.proposer)}
                  </div>
                </div>

                <p className="proposal-desc">{prop.description}</p>

                <div className="proposal-tally-section">
                  <div className="tally-stats-row">
                    <span className="tally-yes">
                      Yes: {yes.toString()} ({yesPercent}%)
                    </span>
                    <span className="tally-no">
                      No: {no.toString()} ({noPercent}%)
                    </span>
                    <span className="tally-quorum">
                      Quorum: {total.toString()} / {quorum.toString()} (
                      {isQuorumMet ? "Met" : "Needed"})
                    </span>
                  </div>
                  <div className="tally-progress-bar">
                    <div
                      className="tally-progress-yes"
                      style={{ width: `${yesPercent}%` }}
                    />
                    <div
                      className="tally-progress-no"
                      style={{ width: `${noPercent}%` }}
                    />
                  </div>
                </div>

                <div className="proposal-actions-row">
                  <div style={{ fontSize: "0.85rem", color: "#9ca3af" }}>
                    {isOpen
                      ? `Voting ends in ${Math.max(
                          0,
                          Math.floor((prop.votingEndsAt - now) / 3600),
                        )} hours`
                      : `Voting ended`}
                  </div>

                  <div className="voting-buttons">
                    {isOpen && (
                      <>
                        <button
                          type="button"
                          className="btn-vote-yes"
                          onClick={() => handleVote(prop.id, true)}
                          disabled={
                            isSubmitting ||
                            prop.hasVoted ||
                            BigInt(effectiveVotes || 0) === 0n
                          }
                        >
                          {prop.hasVoted && prop.userVote === true
                            ? "Voted Yes"
                            : "Vote Yes"}
                        </button>
                        <button
                          type="button"
                          className="btn-vote-no"
                          onClick={() => handleVote(prop.id, false)}
                          disabled={
                            isSubmitting ||
                            prop.hasVoted ||
                            BigInt(effectiveVotes || 0) === 0n
                          }
                        >
                          {prop.hasVoted && prop.userVote === false
                            ? "Voted No"
                            : "Vote No"}
                        </button>
                      </>
                    )}
                    {canExecute && (
                      <button
                        type="button"
                        className="gov-btn-primary"
                        onClick={() => handleExecute(prop.id)}
                        disabled={isSubmitting}
                      >
                        Execute Proposal
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Create Proposal Modal */}
      {showCreateModal && (
        <div className="modal-backdrop">
          <div className="modal-content">
            <div className="modal-header">
              <h2>Create Governance Proposal</h2>
              <button
                type="button"
                className="gov-tab-btn"
                onClick={() => setShowCreateModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateProposal} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div className="gov-form-group">
                <label>Proposal Title</label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Adjust Platform Royalty Rate"
                />
              </div>

              <div className="gov-form-group">
                <label>Description & Rationale</label>
                <textarea
                  rows={3}
                  required
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Explain why this proposal should be adopted..."
                />
              </div>

              <div className="gov-form-group">
                <label>Proposal Action</label>
                <select
                  value={actionType}
                  onChange={(e) => setActionType(e.target.value as GovProposalActionType)}
                >
                  <option value="ChangeRoyaltyRate">Change Royalty Rate</option>
                  <option value="SetTokenFeeOverride">Set Token Fee Override</option>
                  <option value="PauseContract">Pause Contract</option>
                  <option value="UnpauseContract">Unpause Contract</option>
                  <option value="RemoveCollaborator">Remove Collaborator</option>
                  <option value="AllocateBudget">Allocate Budget</option>
                </select>
              </div>

              {actionType === "ChangeRoyaltyRate" && (
                <div className="gov-form-group">
                  <label>New Royalty Rate (Basis Points, 1-10000)</label>
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    required
                    value={newRate}
                    onChange={(e) => setNewRate(e.target.value)}
                  />
                </div>
              )}

              {actionType === "SetTokenFeeOverride" && (
                <>
                  <div className="gov-form-group">
                    <label>Token Contract Address</label>
                    <input
                      type="text"
                      required
                      value={tokenAddress}
                      onChange={(e) => setTokenAddress(e.target.value)}
                      placeholder="C..."
                    />
                  </div>
                  <div className="gov-form-group">
                    <label>Fee Basis Points (bps)</label>
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      required
                      value={feeBps}
                      onChange={(e) => setFeeBps(e.target.value)}
                    />
                  </div>
                </>
              )}

              {actionType === "RemoveCollaborator" && (
                <div className="gov-form-group">
                  <label>Collaborator Address to Remove</label>
                  <input
                    type="text"
                    required
                    value={collabAddress}
                    onChange={(e) => setCollabAddress(e.target.value)}
                    placeholder="G..."
                  />
                </div>
              )}

              {actionType === "AllocateBudget" && (
                <>
                  <div className="gov-form-group">
                    <label>Token Contract Address</label>
                    <input
                      type="text"
                      required
                      value={tokenAddress}
                      onChange={(e) => setTokenAddress(e.target.value)}
                      placeholder="C..."
                    />
                  </div>
                  <div className="gov-form-group">
                    <label>Recipient Address</label>
                    <input
                      type="text"
                      required
                      value={budgetRecipient}
                      onChange={(e) => setBudgetRecipient(e.target.value)}
                      placeholder="G..."
                    />
                  </div>
                  <div className="gov-form-group">
                    <label>Amount</label>
                    <input
                      type="number"
                      required
                      min="1"
                      value={budgetAmount}
                      onChange={(e) => setBudgetAmount(e.target.value)}
                      placeholder="1000"
                    />
                  </div>
                </>
              )}

              <div className="gov-form-group">
                <label>Voting Period</label>
                <select
                  value={votingDurationDays}
                  onChange={(e) => setVotingDurationDays(Number(e.target.value))}
                >
                  <option value={2}>2 Days (Minimum)</option>
                  <option value={3}>3 Days (Standard)</option>
                  <option value={5}>5 Days</option>
                  <option value={7}>7 Days (Maximum)</option>
                </select>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1rem" }}>
                <button
                  type="button"
                  className="gov-btn-secondary"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="gov-btn-primary" disabled={isSubmitting}>
                  {isSubmitting ? "Submitting..." : "Create Proposal"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delegation Modal */}
      {showDelegateModal && (
        <div className="modal-backdrop">
          <div className="modal-content">
            <div className="modal-header">
              <h2>Delegate Voting Power</h2>
              <button
                type="button"
                className="gov-tab-btn"
                onClick={() => setShowDelegateModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleDelegateSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <p style={{ fontSize: "0.9rem", color: "#9ca3af", margin: 0 }}>
                Delegating transfers your voting power to another trusted wallet. You retain full
                ownership of your tokens and can revoke delegation at any time. Delegation cycles
                (e.g., A &rarr; B &rarr; A) are strictly rejected.
              </p>
              <div className="gov-form-group">
                <label>Delegatee Stellar Address</label>
                <input
                  type="text"
                  required
                  value={delegateInput}
                  onChange={(e) => setDelegateInput(e.target.value)}
                  placeholder="G..."
                />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1rem" }}>
                <button
                  type="button"
                  className="gov-btn-secondary"
                  onClick={() => setShowDelegateModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="gov-btn-primary" disabled={isSubmitting || !delegateInput}>
                  {isSubmitting ? "Submitting..." : "Confirm Delegation"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default GovernancePortal;
