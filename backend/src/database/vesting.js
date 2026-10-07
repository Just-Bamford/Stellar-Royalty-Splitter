import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { countWrite } from "./index.js";
import logger from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "..", "..", "audit.db");
const db = new Database(dbPath);

/**
 * #983: Time-locked vesting contracts for team incentives
 */

/**
 * Create a new vesting schedule
 * @param {object} params - Vesting parameters
 * @returns {number} Schedule ID
 */
export function createVestingSchedule({
  contractId,
  beneficiary,
  totalAmount,
  tokenAddress,
  startTime,
  cliffDuration, // in seconds
  vestingDuration, // in seconds
  createdBy,
}) {
  const stmt = db.prepare(`
    INSERT INTO vesting_schedules 
    (contractId, beneficiary, totalAmount, tokenAddress, startTime, cliffDuration, vestingDuration, releasedAmount, createdBy, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  const result = stmt.run(
    contractId,
    beneficiary,
    totalAmount,
    tokenAddress,
    startTime,
    cliffDuration,
    vestingDuration,
    "0",
    createdBy,
    now
  );

  countWrite();
  logger.info("Vesting schedule created", { scheduleId: result.lastInsertRowid, beneficiary, totalAmount });

  return result.lastInsertRowid;
}

/**
 * Calculate vested amount at a given time
 * @param {number} scheduleId - Schedule ID
 * @param {string} currentTime - ISO timestamp (defaults to now)
 * @returns {object} { vestedAmount, releasableAmount }
 */
export function calculateVestedAmount(scheduleId, currentTime = new Date().toISOString()) {
  const schedule = db
    .prepare(`SELECT * FROM vesting_schedules WHERE id = ?`)
    .get(scheduleId);

  if (!schedule) {
    throw new Error(`Vesting schedule ${scheduleId} not found`);
  }

  const startTimestamp = new Date(schedule.startTime).getTime();
  const currentTimestamp = new Date(currentTime).getTime();
  const cliffEnd = startTimestamp + schedule.cliffDuration * 1000;
  const vestingEnd = startTimestamp + schedule.vestingDuration * 1000;

  // Before cliff: nothing vested
  if (currentTimestamp < cliffEnd) {
    return {
      vestedAmount: "0",
      releasableAmount: "0",
      status: "cliff",
    };
  }

  const totalAmount = BigInt(schedule.totalAmount);
  const releasedAmount = BigInt(schedule.releasedAmount);

  // After cliff but before full vesting: linear unlock
  if (currentTimestamp < vestingEnd) {
    const timeElapsed = currentTimestamp - startTimestamp;
    const vestingDuration = schedule.vestingDuration * 1000;
    const vestedAmount = (totalAmount * BigInt(timeElapsed)) / BigInt(vestingDuration);
    const releasableAmount = vestedAmount - releasedAmount;

    return {
      vestedAmount: vestedAmount.toString(),
      releasableAmount: releasableAmount > 0n ? releasableAmount.toString() : "0",
      status: "vesting",
    };
  }

  // Fully vested
  const releasableAmount = totalAmount - releasedAmount;

  return {
    vestedAmount: totalAmount.toString(),
    releasableAmount: releasableAmount > 0n ? releasableAmount.toString() : "0",
    status: "fully_vested",
  };
}

/**
 * Release vested tokens
 */
export function releaseVestedTokens(scheduleId, amount, txHash) {
  const schedule = db
    .prepare(`SELECT * FROM vesting_schedules WHERE id = ?`)
    .get(scheduleId);

  if (!schedule) {
    throw new Error(`Vesting schedule ${scheduleId} not found`);
  }

  const { releasableAmount } = calculateVestedAmount(scheduleId);

  if (BigInt(amount) > BigInt(releasableAmount)) {
    throw new Error(
      `Cannot release ${amount}: only ${releasableAmount} is available (already released: ${schedule.releasedAmount})`
    );
  }

  // Update released amount
  const newReleasedAmount = (BigInt(schedule.releasedAmount) + BigInt(amount)).toString();
  db.prepare(`UPDATE vesting_schedules SET releasedAmount = ? WHERE id = ?`).run(
    newReleasedAmount,
    scheduleId
  );
  countWrite();

  // Record the release
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO vesting_releases (scheduleId, amount, releasedAt, txHash) VALUES (?, ?, ?, ?)`).run(
    scheduleId,
    amount,
    now,
    txHash
  );
  countWrite();

  logger.info("Vesting tokens released", { scheduleId, amount, txHash });

  return {
    scheduleId,
    amount,
    newReleasedAmount,
    remaining: (BigInt(schedule.totalAmount) - BigInt(newReleasedAmount)).toString(),
  };
}

/**
 * Get vesting schedule by ID
 */
export function getVestingSchedule(scheduleId) {
  return db.prepare(`SELECT * FROM vesting_schedules WHERE id = ?`).get(scheduleId);
}

/**
 * Get all vesting schedules for a beneficiary
 */
export function getVestingSchedulesByBeneficiary(beneficiary) {
  return db
    .prepare(`SELECT * FROM vesting_schedules WHERE beneficiary = ? ORDER BY createdAt DESC`)
    .all(beneficiary);
}

/**
 * Get all vesting schedules for a contract
 */
export function getVestingSchedulesByContract(contractId) {
  return db
    .prepare(`SELECT * FROM vesting_schedules WHERE contractId = ? ORDER BY createdAt DESC`)
    .all(contractId);
}

/**
 * Get release history for a schedule
 */
export function getVestingReleaseHistory(scheduleId) {
  return db
    .prepare(`SELECT * FROM vesting_releases WHERE scheduleId = ? ORDER BY releasedAt DESC`)
    .all(scheduleId);
}

/**
 * Get all schedules that have releasable tokens
 */
export function getSchedulesWithReleasableTokens() {
  const now = new Date().toISOString();
  const allSchedules = db.prepare(`SELECT id FROM vesting_schedules`).all();

  return allSchedules
    .map((s) => {
      const calc = calculateVestedAmount(s.id, now);
      if (BigInt(calc.releasableAmount) > 0n) {
        return {
          ...getVestingSchedule(s.id),
          ...calc,
        };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * Cancel a vesting schedule (admin only)
 */
export function cancelVestingSchedule(scheduleId, cancelledBy, reason) {
  const stmt = db.prepare(`
    UPDATE vesting_schedules
    SET status = 'cancelled', cancelledBy = ?, cancelledAt = ?, cancellationReason = ?
    WHERE id = ? AND status = 'active'
  `);

  const now = new Date().toISOString();
  const result = stmt.run(cancelledBy, now, reason, scheduleId);
  countWrite();

  if (result.changes === 0) {
    throw new Error(`Vesting schedule ${scheduleId} not found or already cancelled`);
  }

  logger.info("Vesting schedule cancelled", { scheduleId, cancelledBy, reason });
}

/**
 * Get vesting statistics for a beneficiary
 */
export function getVestingStatistics(beneficiary) {
  const schedules = getVestingSchedulesByBeneficiary(beneficiary);
  const now = new Date().toISOString();

  let totalVested = 0n;
  let totalReleasable = 0n;
  let totalReleased = 0n;
  let totalLocked = 0n;

  schedules.forEach((schedule) => {
    if (schedule.status !== "active") return;

    const { vestedAmount, releasableAmount } = calculateVestedAmount(schedule.id, now);
    totalVested += BigInt(vestedAmount);
    totalReleasable += BigInt(releasableAmount);
    totalReleased += BigInt(schedule.releasedAmount);
    totalLocked += BigInt(schedule.totalAmount) - BigInt(vestedAmount);
  });

  return {
    activeSchedules: schedules.filter((s) => s.status === "active").length,
    totalSchedules: schedules.length,
    totalVested: totalVested.toString(),
    totalReleasable: totalReleasable.toString(),
    totalReleased: totalReleased.toString(),
    totalLocked: totalLocked.toString(),
  };
}
