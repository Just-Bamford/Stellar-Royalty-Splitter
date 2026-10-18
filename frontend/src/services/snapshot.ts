/**
 * Snapshot service for frontend integration
 * Handles Snapshot API calls and voting interface
 */

const SNAPSHOT_API_URL = "https://hub.snapshot.org";
const SNAPSHOT_SPACE = import.meta.env.VITE_SNAPSHOT_SPACE || "stellar-royalty-splitter";

export interface Proposal {
  id: string;
  title: string;
  body: string;
  choices: string[];
  start: number;
  end: number;
  snapshot: number;
  state: "active" | "closed" | "pending";
  author: string;
  space: {
    id: string;
    name: string;
  };
  scores: number[];
  scores_total: number;
  scores_by_strategy: any[];
  strategies: any[];
  type: string;
  link: string;
}

export interface Vote {
  proposal: string;
  voter: string;
  choice: number;
  votingPower: number;
  created: number;
}

export interface VotingPower {
  address: string;
  votingPower: number;
}

/**
 * Fetch active proposals from Snapshot
 */
export async function fetchProposals(): Promise<Proposal[]> {
  try {
    const response = await fetch(`${SNAPSHOT_API_URL}/api/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        where: {
          space_in: [SNAPSHOT_SPACE],
          state: "active"
        },
        orderBy: "created",
        orderDirection: "desc"
      })
    });

    if (!response.ok) {
      throw new Error(`Snapshot API error: ${response.statusText}`);
    }

    const proposals = await response.json();
    return proposals.map(formatProposal);
  } catch (error) {
    console.error("Failed to fetch Snapshot proposals:", error);
    return [];
  }
}

/**
 * Fetch a specific proposal by ID
 */
export async function fetchProposal(proposalId: string): Promise<Proposal | null> {
  try {
    const response = await fetch(`${SNAPSHOT_API_URL}/api/proposal/${proposalId}`);

    if (!response.ok) {
      throw new Error(`Snapshot API error: ${response.statusText}`);
    }

    const proposal = await response.json();
    return formatProposal(proposal);
  } catch (error) {
    console.error("Failed to fetch Snapshot proposal:", error);
    return null;
  }
}

/**
 * Fetch vote results for a proposal
 */
export async function fetchVotes(proposalId: string): Promise<Vote[]> {
  try {
    const response = await fetch(`${SNAPSHOT_API_URL}/api/proposal/${proposalId}/votes`);

    if (!response.ok) {
      throw new Error(`Snapshot API error: ${response.statusText}`);
    }

    const votes = await response.json();
    return votes.map(formatVote);
  } catch (error) {
    console.error("Failed to fetch Snapshot votes:", error);
    return [];
  }
}

/**
 * Get voting power for an address
 */
export async function getVotingPower(address: string): Promise<number> {
  try {
    const response = await fetch(`${SNAPSHOT_API_URL}/api/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        space: SNAPSHOT_SPACE,
        address,
        strategies: JSON.parse(import.meta.env.VITE_SNAPSHOT_STRATEGIES || "[]")
      })
    });

    if (!response.ok) {
      throw new Error(`Snapshot API error: ${response.statusText}`);
    }

    const scores = await response.json();
    return scores[address] || 0;
  } catch (error) {
    console.error("Failed to get voting power:", error);
    return 0;
  }
}

/**
 * Cast a vote on Snapshot (requires signature)
 */
export async function castVote(
  proposalId: string,
  choice: number,
  address: string
): Promise<void> {
  try {
    // This would typically use ethers.js or similar to sign the vote
    // For now, we'll delegate to the backend API
    const response = await fetch("/api/v1/governance/votes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposalId,
        voterAddress: address,
        choice,
        votingPower: await getVotingPower(address)
      })
    });

    if (!response.ok) {
      throw new Error("Failed to cast vote");
    }
  } catch (error) {
    console.error("Failed to cast vote:", error);
    throw error;
  }
}

function formatProposal(proposal: any): Proposal {
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
    link: `https://snapshot.org/#/${proposal.space.id}/proposal/${proposal.id}`
  };
}

function formatVote(vote: any): Vote {
  return {
    proposal: vote.proposal,
    voter: vote.voter,
    choice: vote.choice,
    votingPower: vote.vp,
    created: vote.created
  };
}
