/**
 * Zero-knowledge proof privacy routes — closes #972.
 *
 * Public endpoints:
 *   POST   /api/v1/zk-privacy/proof/generate        — generate private distribution proof
 *   POST   /api/v1/zk-privacy/proof/verify          — verify a proof
 *   GET    /api/v1/zk-privacy/proofs/:contractId    — get proofs for contract
 *   POST   /api/v1/zk-privacy/credential/issue      — issue anonymous credential
 *   GET    /api/v1/zk-privacy/credential/:id        — get credential
 *   GET    /api/v1/zk-privacy/statistics            — privacy statistics
 *
 * Admin endpoints:
 *   GET    /api/v1/zk-privacy/admin/audit           — audit log
 *   POST   /api/v1/zk-privacy/admin/credential/revoke — revoke credential
 */

import { Router } from "express";
import logger from "../logger.js";
import { sendError } from "../error-response.js";
import {
  generatePrivateDistributionProof,
  verifyPrivateDistributionProof,
  generateAnonymousCredential,
  verifyAnonymousCredential,
} from "../services/zk-proof.js";
import {
  storeDistributionProof,
  getDistributionProof,
  getDistributionProofs,
  markProofVerified,
  storeNullifier,
  isNullifierUsed,
  issueAnonymousCredential,
  getAnonymousCredential,
  getCredentialsByWallet,
  markCredentialUsed,
  revokeCredential,
  getZKAuditLog,
  getZKPrivacyStatistics,
} from "../database/zk-privacy.js";

export const zkPrivacyRouter = Router();

// ─── Admin auth middleware ────────────────────────────────────────────────────

function extractBearerToken(req) {
  const header = req.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function requireAdminToken(req, res, next) {
  const envToken = process.env.ADMIN_ROTATE_TOKEN;
  if (!envToken) {
    return sendError(res, 503, "service_unavailable", "Admin operations not configured");
  }
  const token = extractBearerToken(req);
  if (!token || token !== envToken) {
    return sendError(res, 401, "unauthorized", "Unauthorized");
  }
  next();
}

// ─── Generate private distribution proof ──────────────────────────────────────

zkPrivacyRouter.post("/proof/generate", async (req, res, next) => {
  try {
    const { contractId, totalAmount, collaborators, tokenId, transactionId } = req.body;

    if (!contractId || !totalAmount || !collaborators || !Array.isArray(collaborators)) {
      return sendError(res, 400, "invalid_input", "contractId, totalAmount, and collaborators array required");
    }

    if (collaborators.length === 0) {
      return sendError(res, 400, "empty_collaborators", "At least one collaborator required");
    }

    // Generate the proof
    const proof = generatePrivateDistributionProof({
      contractId,
      totalAmount: parseFloat(totalAmount),
      collaborators,
      tokenId: tokenId || 'XLM',
    });

    // Store in database
    const stored = storeDistributionProof(
      contractId,
      transactionId || null,
      'private_distribution',
      proof.totalCommitment,
      collaborators.length,
      proof
    );

    // Store nullifiers
    if (proof.membershipProofs) {
      for (const mp of proof.membershipProofs) {
        if (mp.nullifier) {
          storeNullifier(mp.nullifier, stored.id);
        }
      }
    }

    logger.info("Private distribution proof generated", {
      proofId: stored.id,
      contractId,
      collaboratorCount: collaborators.length,
    });

    return res.status(201).json({
      success: true,
      data: {
        proofId: stored.id,
        proof: {
          ...proof,
          // Remove verification data from response
          _verification: undefined,
        },
      },
      message: "Private distribution proof generated successfully",
    });
  } catch (err) {
    next(err);
  }
});

// ─── Verify private distribution proof ────────────────────────────────────────

zkPrivacyRouter.post("/proof/verify", async (req, res, next) => {
  try {
    const { proofId, proof } = req.body;

    let proofToVerify;

    if (proofId) {
      const stored = getDistributionProof(proofId);
      if (!stored) {
        return sendError(res, 404, "proof_not_found", "Proof not found");
      }
      proofToVerify = stored.proofData;
    } else if (proof) {
      proofToVerify = proof;
    } else {
      return sendError(res, 400, "missing_proof", "Either proofId or proof object required");
    }

    // Verify the proof
    const verificationResult = verifyPrivateDistributionProof(proofToVerify);

    // Update database if proofId provided
    if (proofId) {
      markProofVerified(proofId, verificationResult.valid);
    }

    logger.info("Proof verification completed", {
      proofId: proofId || 'inline',
      valid: verificationResult.valid,
    });

    return res.json({
      success: true,
      data: verificationResult,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Get proofs for a contract ────────────────────────────────────────────────

zkPrivacyRouter.get("/proofs/:contractId", (req, res, next) => {
  try {
    const { contractId } = req.params;
    const { limit, offset } = req.query;

    const proofs = getDistributionProofs(
      contractId,
      Math.min(parseInt(limit) || 50, 100),
      parseInt(offset) || 0
    );

    return res.json({
      success: true,
      data: proofs,
      count: proofs.length,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Issue anonymous credential ───────────────────────────────────────────────

zkPrivacyRouter.post("/credential/issue", async (req, res, next) => {
  try {
    const { walletAddress, attributes } = req.body;

    if (!walletAddress) {
      return sendError(res, 400, "missing_wallet", "walletAddress required");
    }

    if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
      return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address");
    }

    // Generate the credential
    const credential = generateAnonymousCredential(walletAddress, attributes || {});

    // Store in database
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1 year expiry

    const stored = issueAnonymousCredential(
      credential.credentialId,
      walletAddress,
      credential.commitment,
      credential.attributes,
      credential.signature,
      expiresAt.toISOString()
    );

    logger.info("Anonymous credential issued", {
      credentialId: credential.credentialId,
      walletAddress,
    });

    return res.status(201).json({
      success: true,
      data: {
        ...credential,
        // Remove secret from response
        _secret: undefined,
        _walletAddress: undefined,
      },
      message: "Anonymous credential issued successfully",
    });
  } catch (err) {
    next(err);
  }
});

// ─── Get credential ───────────────────────────────────────────────────────────

zkPrivacyRouter.get("/credential/:credentialId", (req, res, next) => {
  try {
    const { credentialId } = req.params;

    const credential = getAnonymousCredential(credentialId);

    if (!credential) {
      return sendError(res, 404, "credential_not_found", "Credential not found");
    }

    if (credential.revoked) {
      return sendError(res, 410, "credential_revoked", "Credential has been revoked");
    }

    // Mark as used
    markCredentialUsed(credentialId);

    return res.json({
      success: true,
      data: credential,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Get credentials by wallet ────────────────────────────────────────────────

zkPrivacyRouter.get("/credentials/wallet/:walletAddress", (req, res, next) => {
  try {
    const { walletAddress } = req.params;
    const { includeRevoked } = req.query;

    const credentials = getCredentialsByWallet(
      walletAddress,
      includeRevoked === 'true'
    );

    return res.json({
      success: true,
      data: credentials,
      count: credentials.length,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Get privacy statistics ───────────────────────────────────────────────────

zkPrivacyRouter.get("/statistics", (req, res, next) => {
  try {
    const statistics = getZKPrivacyStatistics();

    return res.json({
      success: true,
      data: statistics,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Admin: Get audit log ─────────────────────────────────────────────────────

zkPrivacyRouter.get("/admin/audit", requireAdminToken, (req, res, next) => {
  try {
    const { proofId, credentialId, action, startDate, endDate, limit, offset } = req.query;

    const filters = {
      proofId: proofId ? parseInt(proofId) : undefined,
      credentialId,
      action,
      startDate,
      endDate,
    };

    const auditLog = getZKAuditLog(
      filters,
      Math.min(parseInt(limit) || 100, 500),
      parseInt(offset) || 0
    );

    return res.json({
      success: true,
      data: auditLog,
      count: auditLog.length,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Admin: Revoke credential ─────────────────────────────────────────────────

zkPrivacyRouter.post("/admin/credential/revoke", requireAdminToken, async (req, res, next) => {
  try {
    const { credentialId, reason } = req.body;

    if (!credentialId) {
      return sendError(res, 400, "missing_credential_id", "credentialId required");
    }

    const credential = getAnonymousCredential(credentialId);
    if (!credential) {
      return sendError(res, 404, "credential_not_found", "Credential not found");
    }

    if (credential.revoked) {
      return sendError(res, 409, "already_revoked", "Credential already revoked");
    }

    revokeCredential(credentialId, reason);

    logger.info("Credential revoked", { credentialId, reason });

    return res.json({
      success: true,
      message: "Credential revoked successfully",
    });
  } catch (err) {
    next(err);
  }
});
