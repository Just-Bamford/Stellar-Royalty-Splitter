/**
 * AI-powered dispute analysis service — closes #961.
 *
 * Provides automated analysis of disputes through:
 * - Transaction pattern detection
 * - Evidence evaluation
 * - Sentiment analysis
 * - Fraud detection
 * - Mediation recommendations
 */

import logger from "../logger.js";
import {
  getDisputeByTicketId,
  getDisputeEvidence,
  storeDisputeAnalysis,
  getDisputeAnalysis,
  addMediationRecommendation,
  getMediationRecommendations,
  getDisputeStatistics,
} from "../database/disputes.js";
import { getTransactionHistory } from "../database/transactions.js";
import { getReputationDetails } from "../database/reputation.js";
import { batchGetTransactionDetails } from "./query-optimizer.js";

/**
 * Analyze transaction patterns for anomalies.
 *
 * @param {number} disputeId
 * @param {string} walletAddress
 * @param {string} contractId
 * @returns {Promise<object>}
 */
async function analyzeTransactionPatterns(disputeId, walletAddress, contractId) {
  try {
    const transactions = contractId
      ? getTransactionHistory(contractId, 100, 0)
      : [];

    // Eliminate N+1 query loop using batched transaction lookup (#984)
    const txHashes = transactions.map((tx) => tx.txHash).filter(Boolean);
    const detailsMap = batchGetTransactionDetails(txHashes);

    const walletTransactions = transactions.filter((tx) => {
      // Check if wallet was involved in transaction via payouts
      const details = detailsMap.get(tx.txHash);
      return details?.payouts?.some((p) => p.collaboratorAddress === walletAddress);
    });

    const findings = {
      totalTransactions: transactions.length,
      walletTransactions: walletTransactions.length,
      missingPayments: 0,
      amountDiscrepancies: [],
      suspiciousPatterns: [],
    };

    // Detect missing payments
    const expectedPayouts = transactions.filter(tx => tx.type === 'distribute').length;
    findings.missingPayments = Math.max(0, expectedPayouts - walletTransactions.length);

    // Check for amount discrepancies
    for (const tx of walletTransactions) {
      const details = detailsMap.get(tx.txHash);
      const payout = details?.payouts?.find(p => p.collaboratorAddress === walletAddress);
      
      if (payout && parseFloat(payout.amountReceived) === 0) {
        findings.amountDiscrepancies.push({
          txHash: tx.txHash,
          timestamp: tx.timestamp,
          issue: 'zero_amount_payout',
        });
      }
    }

    // Calculate confidence score
    let confidenceScore = 70;
    if (findings.missingPayments > 0) confidenceScore += 10;
    if (findings.amountDiscrepancies.length > 0) confidenceScore += 15;
    confidenceScore = Math.min(100, confidenceScore);

    const recommendations = {
      action: findings.missingPayments > 0 || findings.amountDiscrepancies.length > 0
        ? 'investigate_further'
        : 'low_priority',
      suggestedResolution: findings.missingPayments > 0
        ? 'Review contract payment distribution logic and verify collaborator shares'
        : 'No immediate action required',
      requiresHumanReview: findings.missingPayments > 2 || findings.amountDiscrepancies.length > 3,
    };

    await storeDisputeAnalysis(
      disputeId,
      'transaction_pattern',
      findings,
      confidenceScore,
      recommendations
    );

    return { findings, confidenceScore, recommendations };
  } catch (error) {
    logger.error("Transaction pattern analysis failed", { disputeId, error: error.message });
    throw error;
  }
}

/**
 * Analyze submitted evidence for completeness and validity.
 *
 * @param {number} disputeId
 * @returns {Promise<object>}
 */
async function analyzeEvidence(disputeId) {
  try {
    const evidence = getDisputeEvidence(disputeId);

    const findings = {
      totalEvidence: evidence.length,
      evidenceTypes: evidence.reduce((acc, e) => {
        acc[e.evidenceType] = (acc[e.evidenceType] || 0) + 1;
        return acc;
      }, {}),
      hasTransactionProof: evidence.some(e => e.evidenceType === 'transaction_proof'),
      hasDocumentation: evidence.some(e => e.evidenceType === 'document'),
      completenessScore: 0,
    };

    // Calculate completeness score
    let completeness = 0;
    if (findings.hasTransactionProof) completeness += 40;
    if (findings.hasDocumentation) completeness += 30;
    if (evidence.length >= 2) completeness += 20;
    if (evidence.some(e => e.description && e.description.length > 50)) completeness += 10;
    findings.completenessScore = completeness;

    const confidenceScore = findings.completenessScore;

    const recommendations = {
      evidenceQuality: completeness >= 70 ? 'sufficient' : 'needs_more_evidence',
      missingEvidence: [],
      nextSteps: [],
    };

    if (!findings.hasTransactionProof) {
      recommendations.missingEvidence.push('transaction_proof');
      recommendations.nextSteps.push('Request transaction hash or blockchain proof');
    }

    if (!findings.hasDocumentation) {
      recommendations.missingEvidence.push('supporting_documentation');
      recommendations.nextSteps.push('Request contract agreement or communication records');
    }

    await storeDisputeAnalysis(
      disputeId,
      'evidence_review',
      findings,
      confidenceScore,
      recommendations
    );

    return { findings, confidenceScore, recommendations };
  } catch (error) {
    logger.error("Evidence analysis failed", { disputeId, error: error.message });
    throw error;
  }
}

/**
 * Analyze dispute text for sentiment and urgency.
 *
 * @param {number} disputeId
 * @param {object} dispute
 * @returns {Promise<object>}
 */
async function analyzeSentiment(disputeId, dispute) {
  try {
    const text = `${dispute.description} ${dispute.comments?.map(c => c.message).join(' ') || ''}`;

    // Simple keyword-based sentiment analysis
    const urgentKeywords = ['urgent', 'immediate', 'asap', 'emergency', 'critical', 'fraud'];
    const negativeKeywords = ['wrong', 'missing', 'never', 'scam', 'stolen', 'lost', 'error'];
    const positiveKeywords = ['resolved', 'thanks', 'appreciate', 'understand', 'resolved'];

    const urgentCount = urgentKeywords.filter(k => text.toLowerCase().includes(k)).length;
    const negativeCount = negativeKeywords.filter(k => text.toLowerCase().includes(k)).length;
    const positiveCount = positiveKeywords.filter(k => text.toLowerCase().includes(k)).length;

    const findings = {
      sentiment: negativeCount > positiveCount ? 'negative' : positiveCount > negativeCount ? 'positive' : 'neutral',
      urgencyLevel: urgentCount > 2 ? 'high' : urgentCount > 0 ? 'medium' : 'low',
      keywordsDetected: {
        urgent: urgentCount,
        negative: negativeCount,
        positive: positiveCount,
      },
      textLength: text.length,
    };

    const confidenceScore = 60 + Math.min(30, urgentCount * 10);

    const recommendations = {
      priority: findings.urgencyLevel === 'high' ? 5 : findings.urgencyLevel === 'medium' ? 3 : 1,
      suggestedResponse: findings.sentiment === 'negative'
        ? 'Acknowledge concerns and provide timeline for resolution'
        : 'Proceed with standard resolution workflow',
      escalate: findings.urgencyLevel === 'high' && findings.sentiment === 'negative',
    };

    await storeDisputeAnalysis(
      disputeId,
      'sentiment_analysis',
      findings,
      confidenceScore,
      recommendations
    );

    return { findings, confidenceScore, recommendations };
  } catch (error) {
    logger.error("Sentiment analysis failed", { disputeId, error: error.message });
    throw error;
  }
}

/**
 * Detect potential fraud indicators.
 *
 * @param {number} disputeId
 * @param {string} walletAddress
 * @returns {Promise<object>}
 */
async function detectFraud(disputeId, walletAddress) {
  try {
    const reputation = getReputationDetails(walletAddress);
    const stats = getDisputeStatistics(disputeId);

    const findings = {
      trustScore: reputation.trustScore,
      reputationTier: reputation.reputationTier,
      totalPayouts: reputation.totalPayoutsReceived,
      fraudIndicators: [],
      riskLevel: 'low',
    };

    // Check for fraud indicators
    if (reputation.trustScore < 30) {
      findings.fraudIndicators.push('low_trust_score');
    }

    if (stats.transactionCount === 0) {
      findings.fraudIndicators.push('no_transaction_history');
    }

    // Check for multiple disputes from same wallet
    const recentActivities = reputation.recentActivities || [];
    const disputeCount = recentActivities.filter(a => a.activityType === 'dispute_opened').length;
    if (disputeCount > 3) {
      findings.fraudIndicators.push('multiple_disputes');
    }

    // Determine risk level
    if (findings.fraudIndicators.length >= 3) {
      findings.riskLevel = 'high';
    } else if (findings.fraudIndicators.length >= 1) {
      findings.riskLevel = 'medium';
    }

    const confidenceScore = 50 + findings.fraudIndicators.length * 15;

    const recommendations = {
      requireManualReview: findings.riskLevel !== 'low',
      suggestedAction: findings.riskLevel === 'high'
        ? 'Escalate to senior admin for fraud investigation'
        : findings.riskLevel === 'medium'
          ? 'Request additional verification from contributor'
          : 'Proceed with normal resolution',
      additionalChecks: findings.fraudIndicators.length > 0
        ? ['Verify wallet ownership', 'Check IP address patterns', 'Review all historical transactions']
        : [],
    };

    await storeDisputeAnalysis(
      disputeId,
      'fraud_detection',
      findings,
      Math.min(100, confidenceScore),
      recommendations
    );

    return { findings, confidenceScore: Math.min(100, confidenceScore), recommendations };
  } catch (error) {
    logger.error("Fraud detection failed", { disputeId, error: error.message });
    throw error;
  }
}

/**
 * Generate comprehensive mediation recommendations.
 *
 * @param {number} disputeId
 * @param {object} allAnalysis
 * @returns {Promise<void>}
 */
async function generateMediationRecommendations(disputeId, allAnalysis) {
  try {
    const { transactionPattern, evidence, sentiment, fraud } = allAnalysis;

    // High-priority recommendation if fraud detected
    if (fraud?.findings.riskLevel === 'high') {
      await addMediationRecommendation(
        disputeId,
        'escalation_required',
        'Escalate to senior administrator for fraud investigation',
        {
          reason: 'High fraud risk detected',
          indicators: fraud.findings.fraudIndicators,
          urgency: 'immediate',
        },
        5
      );
    }

    // Evidence-based recommendation
    if (evidence?.findings.completenessScore < 70) {
      await addMediationRecommendation(
        disputeId,
        'human_review_suggested',
        'Request additional evidence from contributor before proceeding',
        {
          reason: 'Insufficient evidence provided',
          missingEvidence: evidence.recommendations.missingEvidence,
          nextSteps: evidence.recommendations.nextSteps,
        },
        3
      );
    }

    // Transaction pattern recommendation
    if (transactionPattern?.findings.missingPayments > 0) {
      await addMediationRecommendation(
        disputeId,
        'automated',
        'Investigate missing payment distributions',
        {
          reason: 'Transaction analysis detected missing payments',
          details: transactionPattern.findings,
          suggestedAction: 'Review contract configuration and distribution logic',
        },
        4
      );
    }

    // Sentiment-based priority adjustment
    if (sentiment?.findings.urgencyLevel === 'high') {
      await addMediationRecommendation(
        disputeId,
        'human_review_suggested',
        'Prioritize response due to high urgency indicators',
        {
          reason: 'High urgency detected in dispute description',
          sentiment: sentiment.findings.sentiment,
          priority: 'expedited',
        },
        4
      );
    }

    // Default low-priority recommendation if no issues
    if (
      fraud?.findings.riskLevel === 'low' &&
      evidence?.findings.completenessScore >= 70 &&
      (!transactionPattern?.findings.missingPayments || transactionPattern.findings.missingPayments === 0)
    ) {
      await addMediationRecommendation(
        disputeId,
        'automated',
        'Standard resolution workflow - low risk dispute',
        {
          reason: 'All analysis indicators show low risk',
          suggestedTimeline: '3-5 business days',
        },
        2
      );
    }

    logger.info("Mediation recommendations generated", { disputeId });
  } catch (error) {
    logger.error("Mediation recommendation generation failed", { disputeId, error: error.message });
    throw error;
  }
}

/**
 * Run comprehensive AI analysis on a dispute.
 *
 * @param {string} ticketId
 * @returns {Promise<object>}
 */
export async function analyzeDispute(ticketId) {
  try {
    const dispute = getDisputeByTicketId(ticketId);
    if (!dispute) {
      throw new Error(`Dispute ${ticketId} not found`);
    }

    logger.info("Starting AI dispute analysis", { ticketId, disputeId: dispute.id });

    const results = {};

    // Run all analysis stages
    results.transactionPattern = await analyzeTransactionPatterns(
      dispute.id,
      dispute.walletAddress,
      dispute.contractId
    );

    results.evidence = await analyzeEvidence(dispute.id);

    results.sentiment = await analyzeSentiment(dispute.id, dispute);

    results.fraud = await detectFraud(dispute.id, dispute.walletAddress);

    // Generate mediation recommendations based on all analysis
    await generateMediationRecommendations(dispute.id, results);

    logger.info("AI dispute analysis completed", { ticketId, disputeId: dispute.id });

    return {
      success: true,
      disputeId: dispute.id,
      ticketId,
      analysis: results,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error("AI dispute analysis failed", { ticketId, error: error.message });
    throw error;
  }
}

/**
 * Get comprehensive analysis report for a dispute.
 *
 * @param {string} ticketId
 * @returns {object}
 */
export function getDisputeAnalysisReport(ticketId) {
  const dispute = getDisputeByTicketId(ticketId);
  if (!dispute) {
    throw new Error(`Dispute ${ticketId} not found`);
  }

  const analysis = getDisputeAnalysis(dispute.id);
  const recommendations = getMediationRecommendations(dispute.id);
  const evidence = getDisputeEvidence(dispute.id);
  const statistics = getDisputeStatistics(dispute.id);

  return {
    dispute,
    analysis,
    recommendations,
    evidence,
    statistics,
  };
}
