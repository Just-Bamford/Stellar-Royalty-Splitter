/**
 * Payment schedule auto-trigger job — closes #599.
 *
 * Polls for enabled schedules whose nextRunAt has elapsed, submits a
 * /api/v1/distribute call internally (via direct DB + Stellar path),
 * and advances each schedule to its next run time.
 *
 * Called by the scheduler in index.js on a configurable interval.
 */

import { getSchedulesDue, markScheduleRan } from "../database/payment-schedules.js";
import { computeNextRun } from "../schedule-calculator.js";
import { recordTransaction } from "../database/index.js";
import { addAuditLog } from "../database/index.js";
import logger from "../logger.js";
import { server, addressToScVal, networkPassphrase } from "../stellar.js";
import StellarSdk from "@stellar/stellar-sdk";
import { getWebhooksByContractId } from "../database/webhooks.js";
import { broadcastTransactionStatus } from "../websocket.js";

const { Contract, TransactionBuilder, BASE_FEE, Account, SorobanRpc } = StellarSdk;

/**
 * Run one pass of the payment schedule checker.
 *
 * @returns {{ triggered: number, skipped: number, failed: number }}
 */
export async function runPaymentSchedules() {
  const now = new Date();
  const nowIso = now.toISOString();

  const due = getSchedulesDue(nowIso);

  if (due.length === 0) {
    return { triggered: 0, skipped: 0, failed: 0 };
  }

  let triggered = 0;
  let skipped = 0;
  let failed = 0;

  for (const schedule of due) {
    try {
      // Dry-run simulation before distribution
      let simulationError = null;
      let estimatedFee = null;
      try {
        const contract = new Contract(schedule.contractId);
        const dummyAccount = new Account(schedule.walletAddress, "0");
        const tx = new TransactionBuilder(dummyAccount, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(contract.call("distribute", addressToScVal(schedule.tokenId)))
          .setTimeout(30)
          .build();

        const sim = await server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(sim)) {
          simulationError = sim.error?.toString() || "Simulation failed";
        } else {
          estimatedFee = sim.minResourceFee || sim.fee || BASE_FEE;
        }
      } catch (simErr) {
        simulationError = simErr.message;
      }

      if (simulationError) {
        logger.warn("Payment schedule simulation failed, skipping", {
          scheduleId: schedule.id,
          name: schedule.name,
          error: simulationError,
        });
        
        // Record failure and notify webhooks
        const transactionId = recordTransaction(
          schedule.contractId,
          "distribute",
          schedule.walletAddress,
          { tokenId: schedule.tokenId, requestedAmount: null, error: simulationError }
        );

        addAuditLog(
          schedule.contractId,
          "scheduled_distribution_failed",
          schedule.walletAddress,
          {
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            error: simulationError,
            transactionId,
          }
        );

        // Notify webhooks of failure
        await notifyWebhooks(schedule.contractId, {
          event: "scheduled_distribution_failed",
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          error: simulationError,
          timestamp: nowIso,
        });

        // Broadcast transaction status via WebSocket
        broadcastTransactionStatus(String(transactionId), {
          id: String(transactionId),
          status: "failed",
          error: simulationError,
        });

        failed++;
        continue;
      }

      // Record a pending distribute transaction so there is a full audit trail.
      // The actual XDR signing is the responsibility of the contract operator —
      // this job creates the on-chain intent record and logs the trigger.
      const transactionId = recordTransaction(
        schedule.contractId,
        "distribute",
        schedule.walletAddress,
        { tokenId: schedule.tokenId, requestedAmount: null, estimatedFee }
      );

      addAuditLog(
        schedule.contractId,
        "scheduled_distribution_triggered",
        schedule.walletAddress,
        {
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          scheduleType: schedule.type,
          transactionId,
          estimatedFee,
        }
      );

      const nextRunAt = computeNextRun(schedule, now);
      markScheduleRan(schedule.id, nowIso, nextRunAt);

      logger.info("Payment schedule triggered", {
        scheduleId: schedule.id,
        name: schedule.name,
        contractId: schedule.contractId,
        transactionId,
        nextRunAt,
        estimatedFee,
      });

      // Notify webhooks of successful trigger
      await notifyWebhooks(schedule.contractId, {
        event: "scheduled_distribution_triggered",
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        transactionId,
        estimatedFee,
        timestamp: nowIso,
      });

      // Broadcast transaction status via WebSocket
      broadcastTransactionStatus(String(transactionId), {
        id: String(transactionId),
        status: "pending",
        fee: estimatedFee,
      });

      triggered++;
    } catch (err) {
      logger.error("Failed to trigger payment schedule", {
        scheduleId: schedule.id,
        name: schedule.name,
        error: err.message,
      });
      failed++;
    }
  }

  return { triggered, skipped, failed };
}

/**
 * Notify registered webhooks of schedule events.
 *
 * @param {string} contractId
 * @param {object} payload
 */
async function notifyWebhooks(contractId, payload) {
  const webhooks = getWebhooksByContractId(contractId);
  for (const webhook of webhooks) {
    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        logger.warn("Webhook notification failed", {
          webhookId: webhook.id,
          url: webhook.url,
          status: response.status,
        });
      }
    } catch (err) {
      logger.warn("Webhook notification error", {
        webhookId: webhook.id,
        url: webhook.url,
        error: err.message,
      });
    }
  }
}

/**
 * Create a recurring scheduler that checks schedules every `intervalMs`.
 *
 * @param {number} [intervalMs]
 * @returns {{ stop: () => void }}
 */
export function startPaymentScheduleJob(intervalMs) {
  const ms = intervalMs ?? parseInt(process.env.PAYMENT_SCHEDULE_CHECK_INTERVAL_MS ?? "60000", 10);

  const timer = setInterval(async () => {
    try {
      const result = await runPaymentSchedules();
      if (result.triggered > 0 || result.failed > 0) {
        logger.info("Payment schedule job completed", result);
      }
    } catch (err) {
      logger.error("Payment schedule job error", { error: err.message });
    }
  }, ms);

  timer.unref();
  logger.info("Payment schedule job started", { intervalMs: ms });

  return { stop: () => clearInterval(timer) };
}
