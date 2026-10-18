/**
 * Snapshot governance service for gasless voting (#995)
 * Implements Snapshot integration with on-chain execution
 *
 * Responsibilities:
 *   - Fetch proposals from Snapshot
 *   - Execute approved proposals on-chain
 *   - Track vote history
 *   - Calculate voting power from token holdings
 */

import logger from "../logger.js";
import { db, countWrite } from "../database/core.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Snapshot API base URL */
export const SNAPSHOT_API_URL = "https://hub.snapshot.org";

/** Snapshot space ID for this project */
export const SNAPSHOT_SPACE = process.env.SNAPSHOT_SPACE || "stellar-royalty-splitter";

/** Minimum voting power to participate (in tokens) */
export const MIN_VOTING_POWER = 1;

/** Minimum quorum for a proposal to pass (percentage) */
export const MIN_QUORUM_PERCENT = 10;

/** Minimum approval for a proposal to pass (percentage) */
export const MIN_APPROVAL_PERCENT = 51;

/** Delay before executing an approved proposal (seconds) */
export const EXECUTION_DELAY = 86400; // 24 hours

// ─── Snapshot API ─────────────────────────────────────────────────────────────

/**
 * Fetch active proposals from Snapshot
 */
export async function fetchProposals() {
  try {
    const response = await fetch(`${SNAPSHOT_API_URL}/api/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        where: {
          space_in: [SNAPSHOT_SPACE],
          state: "active",
        },
        orderBy: "created",
        orderDirection: "desc",
      }),
    });

    if (!response.ok) {
      throw new Error(`Snapshot API error: ${response.statusText}`);
    }

    const proposals = await response.json();
    return proposals.map(formatProposal);
  } catch (error) {
    logger.error("Failed to fetch Snapshot proposals", { error: error.message });
    return [];
  }
}

/**
 * Fetch a specific proposal by ID
 */
export async function fetchProposal(proposalId) {
  try {
    const response = await fetch(`${SNAPSHOT_API_URL}/api/proposal/${proposalId}`);

    if (!response.ok) {
      throw new Error(`Snapshot API error: ${response.statusText}`);
    }

    const proposal = await response.json();
    return formatProposal(proposal);
  } catch (error) {
    logger.error("Failed to fetch Snapshot proposal", { proposalId, error: error.message });
    return null;
  }
}

/**
 * Fetch vote results for a proposal
 */
export async function fetchVotes(proposalId) {
  try {
    const response = await fetch(`${SNAPSHOT_API_URL}/api/proposal/${proposalId}/votes`);

    if (!response.ok) {
      throw new Error(`Snapshot API error: ${response.statusText}`);
    }

    const votes = await response.json();
    return votes.map(formatVote);
  } catch (error) {
    logger.error("Failed to fetch Snapshot votes", { proposalId, error: error.message });
    return [];
  }
}

/**
 * Get voting power for an address
 */
export async function getVotingPower(address) {
  try {
    const response = await fetch(`${SNAPSHOT_API_URL}/api/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        space: SNAPSHOT_SPACE,
        address,
        strategies: JSON.parse(process.env.SNAPSHOT_STRATEGIES || "[]"),
      }),
    });

    if (!response.ok) {
      throw new Error(`Snapshot API error: ${response.statusText}`);
    }

    const scores = await response.json();
    return scores[address] || 0;
  } catch (error) {
    logger.error("Failed to get voting power", { address, error: error.message });
    return 0;
  }
}

// ─── Vote Execution ───────────────────────────────────────────────────────────

/**
 * Execute an approved proposal on-chain
 */
export async function executeProposal(proposalId, executorAddress) {
  try {
    const proposal = await fetchProposal(proposalId);
    if (!proposal) {
      throw new Error("Proposal not found");
    }

    // Check if proposal can be executed
    if (proposal.state !== "closed") {
      throw new Error("Proposal must be closed before execution");
    }

    if (proposal.scores_total < MIN_QUORUM_PERCENT) {
      throw new Error("Quorum not reached");
    }

    const approvalPercent = (proposal.scores[0] / proposal.scores_total) * 100;
    if (approvalPercent < MIN_APPROVAL_PERCENT) {
      throw new Error("Approval threshold not reached");
    }

    // Check execution delay
    const executionTime = new Date(proposal.end).getTime() + EXECUTION_DELAY * 1000;
    if (Date.now() < executionTime) {
      throw new Error("Execution delay not elapsed");
    }

    // Record execution attempt
    const stmt = db.prepare(`
      INSERT INTO governance_executions
        (proposalId, executorAddress, executedAt, status, txHash)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(proposalId, executorAddress, new Date().toISOString(), "pending", null);
    countWrite();

    // TODO: Execute actual on-chain transaction based on proposal type (#995)
    // Currently: Records execution attempt as "pending"; execution step is deferred
    // Implementation needed: Integrate with Stellar SDK to execute the approved action
    // This would translate proposal choices into contract invocations

    logger.info("Proposal execution queued", { proposalId, executorAddress });

    return { success: true, proposalId, status: "pending" };
  } catch (error) {
    logger.error("Failed to execute proposal", { proposalId, error: error.message });
    throw error;
  }
}

/**
 * Update execution status after on-chain transaction
 */
export function updateExecutionStatus(proposalId, txHash, status) {
  try {
    const stmt = db.prepare(`
      UPDATE governance_executions
      SET status = ?, txHash = ?, executedAt = ?
      WHERE proposalId = ?
    `);
    stmt.run(status, txHash, new Date().toISOString(), proposalId);
    countWrite();

    logger.info("Execution status updated", { proposalId, txHash, status });
  } catch (error) {
    logger.error("Failed to update execution status", { proposalId, error: error.message });
  }
}

// ─── Vote History ─────────────────────────────────────────────────────────────

/**
 * Record a vote in local database
 */
export function recordVote(proposalId, voterAddress, choice, votingPower) {
  try {
    const stmt = db.prepare(`
      INSERT INTO governance_votes
        (proposalId, voterAddress, choice, votingPower, votedAt)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(proposalId, voterAddress, choice, votingPower, new Date().toISOString());
    countWrite();

    logger.info("Vote recorded", { proposalId, voterAddress, choice, votingPower });
  } catch (error) {
    logger.error("Failed to record vote", { proposalId, voterAddress, error: error.message });
  }
}

/**
 * Get vote history for a proposal
 */
export function getProposalVotes(proposalId) {
  try {
    const stmt = db.prepare(`
      SELECT * FROM governance_votes
      WHERE proposalId = ?
      ORDER BY votedAt DESC
    `);
    return stmt.all(proposalId);
  } catch (error) {
    logger.error("Failed to get proposal votes", { proposalId, error: error.message });
    return [];
  }
}

/**
 * Get vote history for an address
 */
export function getVoterVotes(address, limit = 50) {
  try {
    const stmt = db.prepare(`
      SELECT * FROM governance_votes
      WHERE voterAddress = ?
      ORDER BY votedAt DESC
      LIMIT ?
    `);
    return stmt.all(address, limit);
  } catch (error) {
    logger.error("Failed to get voter votes", { address, error: error.message });
    return [];
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatProposal(proposal) {
  return {
    id: proposal.id,
    title: proposal.title,
    body: proposal.body,
    choices: proposal.choices,
    start: proposal.start,
    end: proposal.end,
    snapshot: proposal.snapshot,
    state: proposal.state,
    author: proposal.author,
    space: proposal.space,
    scores: proposal.scores,
    scores_total: proposal.scores_total,
    scores_by_strategy: proposal.scores_by_strategy,
    strategies: proposal.strategies,
    type: proposal.type,
    link: `https://snapshot.org/#/${proposal.space.id}/proposal/${proposal.id}`,
  };
}

function formatVote(vote) {
  return {
    proposal: vote.proposal,
    voter: vote.voter,
    choice: vote.choice,
    votingPower: vote.vp,
    created: vote.created,
  };
}
