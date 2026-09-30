/**
 * Snapshot governance routes
 * Provides API endpoints for Snapshot integration and vote execution
 */

import { Router } from "express";
import { z } from "zod";
import logger from "../../logger.js";
import { sendError } from "../../error-response.js";
import { validate, validateQuery } from "../../validation.js";
import {
  fetchProposals,
  fetchProposal,
  fetchVotes,
  getVotingPower,
  executeProposal,
  updateExecutionStatus,
  recordVote,
  getProposalVotes,
  getVoterVotes
} from "../../services/snapshot-governance.js";

export const snapshotRouter = Router();

// ─── Validation schemas ───────────────────────────────────────────────────────

const proposalIdSchema = z.object({
  proposalId: z.string().min(1, "proposalId is required")
});

const executeProposalSchema = z.object({
  proposalId: z.string().min(1, "proposalId is required"),
  executorAddress: z.string().min(1, "executorAddress is required")
});

const recordVoteSchema = z.object({
  proposalId: z.string().min(1, "proposalId is required"),
  voterAddress: z.string().min(1, "voterAddress is required"),
  choice: z.number().int().min(0, "choice must be non-negative"),
  votingPower: z.number().nonnegative("votingPower must be non-negative")
});

const votesQuerySchema = z.object({
  proposalId: z.string().optional(),
  address: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

// ─── Public endpoints ────────────────────────────────────────────────────────

/** GET /api/v1/governance/proposals - Get active proposals */
snapshotRouter.get("/proposals", async (req, res) => {
  try {
    const proposals = await fetchProposals();
    res.json({ success: true, count: proposals.length, data: proposals });
  } catch (error) {
    logger.error("Failed to fetch proposals", { error: error.message });
    sendError(res, 500, "fetch_failed", "Failed to fetch proposals");
  }
});

/** GET /api/v1/governance/proposals/:proposalId - Get specific proposal */
snapshotRouter.get(
  "/proposals/:proposalId",
  validate(proposalIdSchema),
  async (req, res) => {
    try {
      const proposal = await fetchProposal(req.params.proposalId);
      if (!proposal) {
        return sendError(res, 404, "proposal_not_found", "Proposal not found");
      }
      res.json({ success: true, data: proposal });
    } catch (error) {
      logger.error("Failed to fetch proposal", { error: error.message });
      sendError(res, 500, "fetch_failed", "Failed to fetch proposal");
    }
  }
);

/** GET /api/v1/governance/proposals/:proposalId/votes - Get proposal votes */
snapshotRouter.get(
  "/proposals/:proposalId/votes",
  validate(proposalIdSchema),
  async (req, res) => {
    try {
      const votes = await fetchVotes(req.params.proposalId);
      res.json({ success: true, count: votes.length, data: votes });
    } catch (error) {
      logger.error("Failed to fetch votes", { error: error.message });
      sendError(res, 500, "fetch_failed", "Failed to fetch votes");
    }
  }
);

/** GET /api/v1/governance/voting-power/:address - Get voting power for address */
snapshotRouter.get(
  "/voting-power/:address",
  async (req, res) => {
    try {
      const address = req.params.address;
      const votingPower = await getVotingPower(address);
      res.json({ success: true, data: { address, votingPower } });
    } catch (error) {
      logger.error("Failed to get voting power", { error: error.message });
      sendError(res, 500, "fetch_failed", "Failed to get voting power");
    }
  }
);

// ─── Admin endpoints ─────────────────────────────────────────────────────────

/** POST /api/v1/governance/execute - Execute approved proposal */
snapshotRouter.post(
  "/execute",
  validate(executeProposalSchema),
  async (req, res) => {
    try {
      const result = await executeProposal(req.body.proposalId, req.body.executorAddress);
      res.json({ success: true, message: "Proposal execution queued", data: result });
    } catch (error) {
      logger.error("Failed to execute proposal", { error: error.message });
      sendError(res, 400, "execution_failed", error.message);
    }
  }
);

/** PATCH /api/v1/governance/execution/:proposalId - Update execution status */
snapshotRouter.patch(
  "/execution/:proposalId",
  async (req, res) => {
    try {
      const { txHash, status } = req.body;
      if (!txHash || !status) {
        return sendError(res, 400, "invalid_request", "txHash and status are required");
      }
      updateExecutionStatus(req.params.proposalId, txHash, status);
      res.json({ success: true, message: "Execution status updated" });
    } catch (error) {
      logger.error("Failed to update execution status", { error: error.message });
      sendError(res, 500, "update_failed", "Failed to update execution status");
    }
  }
);

// ─── Vote history endpoints ───────────────────────────────────────────────────

/** POST /api/v1/governance/votes - Record a vote */
snapshotRouter.post(
  "/votes",
  validate(recordVoteSchema),
  async (req, res) => {
    try {
      recordVote(req.body.proposalId, req.body.voterAddress, req.body.choice, req.body.votingPower);
      res.json({ success: true, message: "Vote recorded" });
    } catch (error) {
      logger.error("Failed to record vote", { error: error.message });
      sendError(res, 500, "record_failed", "Failed to record vote");
    }
  }
);

/** GET /api/v1/governance/votes - Get vote history */
snapshotRouter.get(
  "/votes",
  validateQuery(votesQuerySchema),
  async (req, res) => {
    try {
      const { proposalId, address, limit } = req.query;
      let votes;

      if (proposalId) {
        votes = getProposalVotes(proposalId);
      } else if (address) {
        votes = getVoterVotes(address, limit);
      } else {
        return sendError(res, 400, "invalid_request", "Either proposalId or address is required");
      }

      res.json({ success: true, count: votes.length, data: votes });
    } catch (error) {
      logger.error("Failed to get votes", { error: error.message });
      sendError(res, 500, "fetch_failed", "Failed to fetch votes");
    }
  }
);

export default snapshotRouter;
