/**
 * Snapshot Voting Component
 * Displays active proposals and allows gasless voting
 */

import React, { useState, useEffect } from "react";
import {
  fetchProposals,
  fetchProposal,
  fetchVotes,
  getVotingPower,
  castVote,
  type Proposal,
  type Vote
} from "../services/snapshot";

export default function SnapshotVoting() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedProposal, setSelectedProposal] = useState<Proposal | null>(null);
  const [votes, setVotes] = useState<Vote[]>([]);
  const [votingPower, setVotingPower] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState(false);
  const [userAddress, setUserAddress] = useState<string>("");

  useEffect(() => {
    loadProposals();
  }, []);

  useEffect(() => {
    if (userAddress) {
      loadVotingPower();
    }
  }, [userAddress]);

  const loadProposals = async () => {
    try {
      const data = await fetchProposals();
      setProposals(data);
      setLoading(false);
    } catch (error) {
      console.error("Failed to load proposals:", error);
      setLoading(false);
    }
  };

  const loadProposal = async (proposalId: string) => {
    try {
      const proposal = await fetchProposal(proposalId);
      setSelectedProposal(proposal);
      loadVotes(proposalId);
    } catch (error) {
      console.error("Failed to load proposal:", error);
    }
  };

  const loadVotes = async (proposalId: string) => {
    try {
      const data = await fetchVotes(proposalId);
      setVotes(data);
    } catch (error) {
      console.error("Failed to load votes:", error);
    }
  };

  const loadVotingPower = async () => {
    try {
      const power = await getVotingPower(userAddress);
      setVotingPower(power);
    } catch (error) {
      console.error("Failed to load voting power:", error);
    }
  };

  const handleVote = async (choice: number) => {
    if (!selectedProposal || !userAddress) return;

    setVoting(true);
    try {
      await castVote(selectedProposal.id, choice, userAddress);
      alert("Vote cast successfully!");
      loadVotes(selectedProposal.id);
    } catch (error) {
      console.error("Failed to cast vote:", error);
      alert("Failed to cast vote. Please try again.");
    } finally {
      setVoting(false);
    }
  };

  const calculateApproval = (choiceIndex: number) => {
    if (!selectedProposal || selectedProposal.scores_total === 0) return 0;
    return ((selectedProposal.scores[choiceIndex] / selectedProposal.scores_total) * 100).toFixed(1);
  };

  const getExecutionStatus = (proposal: Proposal) => {
    if (proposal.state === "active") return "Active";
    if (proposal.state === "pending") return "Pending";
    if (proposal.state === "closed") {
      const approval = proposal.scores_total > 0
        ? (proposal.scores[0] / proposal.scores_total) * 100
        : 0;
      if (approval >= 51) return "Approved - Pending Execution";
      return "Rejected";
    }
    return proposal.state;
  };

  if (loading) {
    return (
      <div className="snapshot-voting">
        <div className="loading">Loading proposals...</div>
      </div>
    );
  }

  return (
    <div className="snapshot-voting">
      <div className="snapshot-header">
        <h2>🗳️ Governance Proposals</h2>
        <p>Vote on proposals using your token holdings (gasless)</p>
      </div>

      {!selectedProposal ? (
        <div className="proposals-list">
          {proposals.length === 0 ? (
            <div className="no-proposals">
              <p>No active proposals at this time.</p>
            </div>
          ) : (
            proposals.map((proposal) => (
              <div
                key={proposal.id}
                className="proposal-card"
                onClick={() => loadProposal(proposal.id)}
              >
                <div className="proposal-header">
                  <h3>{proposal.title}</h3>
                  <span className={`status ${proposal.state}`}>
                    {getExecutionStatus(proposal)}
                  </span>
                </div>
                <div className="proposal-meta">
                  <span>By {proposal.author.slice(0, 6)}...{proposal.author.slice(-4)}</span>
                  <span>
                    Ends: {new Date(proposal.end * 1000).toLocaleDateString()}
                  </span>
                </div>
                <div className="proposal-stats">
                  <div className="stat">
                    <span className="label">Total Votes:</span>
                    <span className="value">{proposal.scores_total.toLocaleString()}</span>
                  </div>
                  {proposal.scores.length > 0 && (
                    <div className="stat">
                      <span className="label">For:</span>
                      <span className="value">{proposal.scores[0].toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="proposal-detail">
          <button
            className="back-button"
            onClick={() => setSelectedProposal(null)}
          >
            ← Back to Proposals
          </button>

          <div className="proposal-info">
            <h2>{selectedProposal.title}</h2>
            <a
              href={selectedProposal.link}
              target="_blank"
              rel="noopener noreferrer"
              className="snapshot-link"
            >
              View on Snapshot →
            </a>
          </div>

          <div className="proposal-body">
            <p>{selectedProposal.body}</p>
          </div>

          <div className="proposal-choices">
            <h3>Vote Options</h3>
            {selectedProposal.choices.map((choice, index) => (
              <div key={index} className="choice-card">
                <div className="choice-header">
                  <span className="choice-label">{choice}</span>
                  <span className="choice-percent">
                    {calculateApproval(index)}%
                  </span>
                </div>
                <div className="choice-bar">
                  <div
                    className="choice-fill"
                    style={{ width: `${calculateApproval(index)}%` }}
                  />
                </div>
                <div className="choice-votes">
                  {selectedProposal.scores[index]?.toLocaleString() || 0} votes
                </div>
                {selectedProposal.state === "active" && userAddress && (
                  <button
                    className="vote-button"
                    onClick={() => handleVote(index)}
                    disabled={voting || votingPower === 0}
                  >
                    {voting ? "Voting..." : "Vote"}
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="voting-power-section">
            <h3>Your Voting Power</h3>
            <input
              type="text"
              placeholder="Enter your wallet address"
              value={userAddress}
              onChange={(e) => setUserAddress(e.target.value)}
              className="address-input"
            />
            {userAddress && (
              <div className="voting-power-display">
                <span className="power-value">{votingPower.toLocaleString()}</span>
                <span className="power-label">tokens</span>
              </div>
            )}
          </div>

          <div className="votes-history">
            <h3>Recent Votes</h3>
            {votes.length === 0 ? (
              <p>No votes yet.</p>
            ) : (
              <div className="votes-list">
                {votes.slice(0, 10).map((vote, index) => (
                  <div key={index} className="vote-item">
                    <span className="voter">
                      {vote.voter.slice(0, 6)}...{vote.voter.slice(-4)}
                    </span>
                    <span className="choice">
                      {selectedProposal.choices[vote.choice]}
                    </span>
                    <span className="power">
                      {vote.votingPower.toLocaleString()} VP
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
