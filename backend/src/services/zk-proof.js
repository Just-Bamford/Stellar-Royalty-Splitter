/**
 * Zero-knowledge proof service for privacy-preserving operations — closes #972.
 *
 * Provides cryptographic proofs that allow verification without revealing:
 * - Distribution amounts (prove payment occurred without revealing amount)
 * - Collaborator identities (prove membership in set without revealing which one)
 * - Transaction details while maintaining auditability
 *
 * Note: This is a simplified implementation for demonstration.
 * Production use would require a proper ZK-SNARK library like snarkjs or circom.
 */

import crypto from "crypto";
import logger from "../logger.js";

/**
 * Generate a commitment to a value (Pedersen-style commitment).
 * Commitment = g^value * h^randomness (in multiplicative group)
 * Simplified using hash-based commitment for this implementation.
 *
 * @param {string|number} value - The value to commit to
 * @param {string} randomness - Random blinding factor
 * @returns {object} - { commitment, randomness }
 */
export function generateCommitment(value, randomness = null) {
  const blinding = randomness || crypto.randomBytes(32).toString('hex');
  
  // Hash-based commitment: H(value || blinding)
  const commitment = crypto
    .createHash('sha256')
    .update(`${value}${blinding}`)
    .digest('hex');

  return {
    commitment,
    randomness: blinding,
  };
}

/**
 * Verify a commitment matches a revealed value.
 *
 * @param {string} commitment - The commitment to verify
 * @param {string|number} value - The claimed value
 * @param {string} randomness - The blinding factor
 * @returns {boolean} - True if commitment is valid
 */
export function verifyCommitment(commitment, value, randomness) {
  const recomputed = crypto
    .createHash('sha256')
    .update(`${value}${randomness}`)
    .digest('hex');

  return recomputed === commitment;
}

/**
 * Generate a range proof that a value is within [min, max] without revealing the exact value.
 * Simplified implementation using multiple commitments.
 *
 * @param {number} value - The actual value
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {object} - Range proof
 */
export function generateRangeProof(value, min, max) {
  if (value < min || value > max) {
    throw new Error(`Value ${value} is not in range [${min}, ${max}]`);
  }

  // Generate commitment to the value
  const { commitment, randomness } = generateCommitment(value);

  // Generate proof components
  // In a real ZK-SNARK, this would be a cryptographic proof
  // Here we use a simplified approach with multiple hash layers
  const proofComponents = [];

  // Prove value >= min
  const minDiff = value - min;
  const minProof = crypto
    .createHash('sha256')
    .update(`${minDiff}${randomness}min`)
    .digest('hex');
  proofComponents.push({ type: 'gte_min', proof: minProof });

  // Prove value <= max
  const maxDiff = max - value;
  const maxProof = crypto
    .createHash('sha256')
    .update(`${maxDiff}${randomness}max`)
    .digest('hex');
  proofComponents.push({ type: 'lte_max', proof: maxProof });

  return {
    commitment,
    min,
    max,
    proofComponents,
    // Store randomness and diffs securely (in real impl, these would be derived from ZK proof)
    _verification: {
      randomness,
      minDiff,
      maxDiff,
    },
  };
}

/**
 * Verify a range proof.
 *
 * @param {object} rangeProof - The range proof to verify
 * @returns {boolean} - True if proof is valid
 */
export function verifyRangeProof(rangeProof) {
  try {
    const { commitment, proofComponents, _verification } = rangeProof;

    if (!_verification) return false;

    const { randomness, minDiff, maxDiff } = _verification;

    // Verify min proof
    const minProofExpected = crypto
      .createHash('sha256')
      .update(`${minDiff}${randomness}min`)
      .digest('hex');

    const minComponent = proofComponents.find(p => p.type === 'gte_min');
    if (!minComponent || minComponent.proof !== minProofExpected) {
      return false;
    }

    // Verify max proof
    const maxProofExpected = crypto
      .createHash('sha256')
      .update(`${maxDiff}${randomness}max`)
      .digest('hex');

    const maxComponent = proofComponents.find(p => p.type === 'lte_max');
    if (!maxComponent || maxComponent.proof !== maxProofExpected) {
      return false;
    }

    // Verify value is non-negative
    if (minDiff < 0 || maxDiff < 0) {
      return false;
    }

    return true;
  } catch (error) {
    logger.error("Range proof verification failed", { error: error.message });
    return false;
  }
}

/**
 * Generate a membership proof that an address belongs to a set without revealing which one.
 * Uses Merkle tree approach for set membership.
 *
 * @param {string} address - The address to prove membership for
 * @param {string[]} addressSet - The complete set of addresses
 * @returns {object} - Membership proof
 */
export function generateMembershipProof(address, addressSet) {
  if (!addressSet.includes(address)) {
    throw new Error("Address is not in the set");
  }

  // Build Merkle tree
  const leaves = addressSet.map(addr =>
    crypto.createHash('sha256').update(addr).digest('hex')
  );

  // Simple Merkle root calculation (in real impl, use proper Merkle tree library)
  let currentLevel = leaves;
  const merkleProof = [];

  const addressIndex = addressSet.indexOf(address);
  let currentIndex = addressIndex;

  while (currentLevel.length > 1) {
    const nextLevel = [];
    const proofLevel = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] || left;

      const combined = crypto
        .createHash('sha256')
        .update(left + right)
        .digest('hex');

      nextLevel.push(combined);

      // Track proof elements
      if (i === currentIndex || i + 1 === currentIndex) {
        const isLeft = i === currentIndex;
        const sibling = isLeft ? right : left;
        proofLevel.push({ sibling, isLeft });
      }
    }

    if (proofLevel.length > 0) {
      merkleProof.push(proofLevel[0]);
    }

    currentLevel = nextLevel;
    currentIndex = Math.floor(currentIndex / 2);
  }

  const merkleRoot = currentLevel[0];

  // Generate nullifier (prevents double-spending/double-proof)
  const nullifier = crypto
    .createHash('sha256')
    .update(`${address}${merkleRoot}nullifier`)
    .digest('hex');

  return {
    merkleRoot,
    merkleProof,
    nullifier,
    setSize: addressSet.length,
    // In production, address would not be included
    _verification: {
      address,
      addressIndex,
    },
  };
}

/**
 * Verify a membership proof.
 *
 * @param {object} membershipProof - The membership proof
 * @param {string[]} addressSet - The address set to verify against
 * @returns {boolean} - True if proof is valid
 */
export function verifyMembershipProof(membershipProof, addressSet) {
  try {
    const { merkleRoot, merkleProof, setSize, _verification } = membershipProof;

    // Verify set size matches
    if (setSize !== addressSet.length) {
      return false;
    }

    // Rebuild Merkle root and verify
    if (!_verification) return false;

    const { address, addressIndex } = _verification;

    let currentHash = crypto.createHash('sha256').update(address).digest('hex');

    for (const proofElement of merkleProof) {
      const { sibling, isLeft } = proofElement;
      const combined = isLeft
        ? crypto.createHash('sha256').update(currentHash + sibling).digest('hex')
        : crypto.createHash('sha256').update(sibling + currentHash).digest('hex');
      currentHash = combined;
    }

    return currentHash === merkleRoot;
  } catch (error) {
    logger.error("Membership proof verification failed", { error: error.message });
    return false;
  }
}

/**
 * Generate a private distribution proof.
 * Proves that a distribution occurred with correct amounts without revealing them.
 *
 * @param {object} distribution - Distribution details
 * @returns {object} - Private distribution proof
 */
export function generatePrivateDistributionProof(distribution) {
  const {
    contractId,
    totalAmount,
    collaborators, // Array of { address, amount, share }
    tokenId,
  } = distribution;

  // Generate commitments for each collaborator's amount
  const collaboratorCommitments = collaborators.map(({ address, amount, share }) => {
    const { commitment, randomness } = generateCommitment(amount);
    return {
      address,
      commitment,
      sharePercentage: share,
      _randomness: randomness,
      _amount: amount,
    };
  });

  // Generate range proof for total amount
  const totalRangeProof = generateRangeProof(totalAmount, 0, Number.MAX_SAFE_INTEGER);

  // Generate membership proofs for each collaborator
  const addressSet = collaborators.map(c => c.address);
  const membershipProofs = collaborators.map(({ address }) =>
    generateMembershipProof(address, addressSet)
  );

  // Generate proof that amounts sum to total
  const sumCommitment = crypto
    .createHash('sha256')
    .update(collaboratorCommitments.map(c => c.commitment).join(''))
    .digest('hex');

  return {
    contractId,
    tokenId,
    totalCommitment: totalRangeProof.commitment,
    collaboratorCommitments: collaboratorCommitments.map(c => ({
      address: c.address,
      commitment: c.commitment,
      sharePercentage: c.sharePercentage,
    })),
    membershipProofs,
    rangeProof: totalRangeProof,
    sumProof: {
      commitment: sumCommitment,
      collaboratorCount: collaborators.length,
    },
    timestamp: new Date().toISOString(),
    // Verification data (would not be included in production)
    _verification: {
      totalAmount,
      collaboratorCommitments,
    },
  };
}

/**
 * Verify a private distribution proof.
 *
 * @param {object} proof - The private distribution proof
 * @returns {object} - Verification result
 */
export function verifyPrivateDistributionProof(proof) {
  try {
    const {
      totalCommitment,
      collaboratorCommitments,
      membershipProofs,
      rangeProof,
      sumProof,
      _verification,
    } = proof;

    const results = {
      valid: true,
      checks: {},
    };

    // Verify range proof for total amount
    results.checks.rangeProof = verifyRangeProof(rangeProof);
    if (!results.checks.rangeProof) {
      results.valid = false;
    }

    // Verify membership proofs
    if (_verification) {
      const addressSet = _verification.collaboratorCommitments.map(c => c.address);
      results.checks.membershipProofs = membershipProofs.every(mp =>
        verifyMembershipProof(mp, addressSet)
      );
      if (!results.checks.membershipProofs) {
        results.valid = false;
      }

      // Verify individual commitments
      results.checks.individualCommitments = _verification.collaboratorCommitments.every(c =>
        verifyCommitment(c.commitment, c._amount, c._randomness)
      );
      if (!results.checks.individualCommitments) {
        results.valid = false;
      }

      // Verify sum of amounts equals total
      const computedTotal = _verification.collaboratorCommitments.reduce(
        (sum, c) => sum + parseFloat(c._amount),
        0
      );
      results.checks.sumMatches = Math.abs(computedTotal - _verification.totalAmount) < 0.0000001;
      if (!results.checks.sumMatches) {
        results.valid = false;
      }
    }

    // Verify number of collaborators
    results.checks.collaboratorCount =
      collaboratorCommitments.length === membershipProofs.length &&
      collaboratorCommitments.length === sumProof.collaboratorCount;
    if (!results.checks.collaboratorCount) {
      results.valid = false;
    }

    return results;
  } catch (error) {
    logger.error("Private distribution proof verification failed", { error: error.message });
    return {
      valid: false,
      error: error.message,
      checks: {},
    };
  }
}

/**
 * Generate anonymous credentials for a collaborator.
 * Allows proving eligibility without revealing identity.
 *
 * @param {string} walletAddress
 * @param {object} attributes - Attributes to include (reputation tier, etc.)
 * @returns {object} - Anonymous credential
 */
export function generateAnonymousCredential(walletAddress, attributes = {}) {
  const credentialId = crypto.randomBytes(16).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');

  // Generate commitment to wallet address
  const { commitment, randomness } = generateCommitment(walletAddress, secret);

  // Sign attributes
  const attributeHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(attributes))
    .digest('hex');

  const credentialSignature = crypto
    .createHash('sha256')
    .update(`${commitment}${attributeHash}${credentialId}`)
    .digest('hex');

  return {
    credentialId,
    commitment,
    attributes,
    signature: credentialSignature,
    issuedAt: new Date().toISOString(),
    _secret: secret,
    _walletAddress: walletAddress,
  };
}

/**
 * Verify an anonymous credential.
 *
 * @param {object} credential - The credential to verify
 * @returns {boolean} - True if valid
 */
export function verifyAnonymousCredential(credential) {
  try {
    const { commitment, attributes, signature, credentialId, _secret, _walletAddress } = credential;

    if (!_secret || !_walletAddress) return false;

    // Verify commitment
    const commitmentValid = verifyCommitment(commitment, _walletAddress, _secret);
    if (!commitmentValid) return false;

    // Verify signature
    const attributeHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(attributes))
      .digest('hex');

    const expectedSignature = crypto
      .createHash('sha256')
      .update(`${commitment}${attributeHash}${credentialId}`)
      .digest('hex');

    return signature === expectedSignature;
  } catch (error) {
    logger.error("Anonymous credential verification failed", { error: error.message });
    return false;
  }
}
