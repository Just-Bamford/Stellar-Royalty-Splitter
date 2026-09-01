import crypto from "crypto";
import { db, countWrite } from "./core.js";

export function subscribeEmailDigest({ walletAddress, email, timezone, dayOfWeek, hourOfDay }) {
  const unsubscribeToken = crypto.randomBytes(32).toString("hex");

  const stmt = db.prepare(`
    INSERT INTO email_digest_subscribers
      (walletAddress, email, timezone, dayOfWeek, hourOfDay, unsubscribeToken)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(walletAddress) DO UPDATE SET
      email = excluded.email,
      timezone = excluded.timezone,
      dayOfWeek = excluded.dayOfWeek,
      hourOfDay = excluded.hourOfDay,
      enabled = 1,
      updatedAt = CURRENT_TIMESTAMP
  `);

  stmt.run(walletAddress, email, timezone, dayOfWeek, hourOfDay, unsubscribeToken);
  countWrite();

  const subscriber = db
    .prepare("SELECT * FROM email_digest_subscribers WHERE walletAddress = ?")
    .get(walletAddress);

  return subscriber;
}

export function getSubscriberByToken(unsubscribeToken) {
  return db
    .prepare("SELECT * FROM email_digest_subscribers WHERE unsubscribeToken = ?")
    .get(unsubscribeToken) ?? null;
}

export function getSubscriberByWallet(walletAddress) {
  return db
    .prepare("SELECT * FROM email_digest_subscribers WHERE walletAddress = ?")
    .get(walletAddress) ?? null;
}

export function unsubscribeByEmailDigest(unsubscribeToken) {
  const stmt = db.prepare(`
    UPDATE email_digest_subscribers
    SET enabled = 0, updatedAt = CURRENT_TIMESTAMP
    WHERE unsubscribeToken = ?
  `);
  stmt.run(unsubscribeToken);
  countWrite();
  return true;
}

export function unsubscribeByWallet(walletAddress) {
  const stmt = db.prepare(`
    UPDATE email_digest_subscribers
    SET enabled = 0, updatedAt = CURRENT_TIMESTAMP
    WHERE walletAddress = ?
  `);
  const result = stmt.run(walletAddress);
  countWrite();
  return result.changes > 0;
}

export function updateSubscriberPreferences({ walletAddress, email, timezone, dayOfWeek, hourOfDay }) {
  const stmt = db.prepare(`
    UPDATE email_digest_subscribers
    SET email = COALESCE(?, email),
        timezone = COALESCE(?, timezone),
        dayOfWeek = COALESCE(?, dayOfWeek),
        hourOfDay = COALESCE(?, hourOfDay),
        updatedAt = CURRENT_TIMESTAMP
    WHERE walletAddress = ? AND enabled = 1
  `);
  const result = stmt.run(email, timezone, dayOfWeek, hourOfDay, walletAddress);
  countWrite();
  return result.changes > 0;
}

export function getAllEnabledSubscribers() {
  return db
    .prepare("SELECT * FROM email_digest_subscribers WHERE enabled = 1")
    .all();
}

export function getSubscribersDueForDigest(currentDayOfWeek, currentHourOfDay) {
  return db
    .prepare(`
      SELECT * FROM email_digest_subscribers
      WHERE enabled = 1
        AND dayOfWeek = ?
        AND hourOfDay = ?
    `)
    .all(currentDayOfWeek, currentHourOfDay);
}

export function wasDigestSentThisWeek(subscriberId, weekStart, weekEnd) {
  const row = db
    .prepare(`
      SELECT id FROM email_digest_log
      WHERE subscriberId = ? AND weekStart = ? AND weekEnd = ?
        AND status = 'sent'
    `)
    .get(subscriberId, weekStart, weekEnd);
  return !!row;
}

export function logDigestSent(subscriberId, weekStart, weekEnd, earningsSummary) {
  const stmt = db.prepare(`
    INSERT INTO email_digest_log
      (subscriberId, weekStart, weekEnd, earningsSummary, status)
    VALUES (?, ?, ?, ?, 'sent')
  `);
  const result = stmt.run(subscriberId, weekStart, weekEnd, JSON.stringify(earningsSummary));
  countWrite();
  return result.lastInsertRowid;
}

export function logDigestFailed(subscriberId, weekStart, weekEnd, earningsSummary) {
  const stmt = db.prepare(`
    INSERT INTO email_digest_log
      (subscriberId, weekStart, weekEnd, earningsSummary, status)
    VALUES (?, ?, ?, ?, 'failed')
  `);
  const result = stmt.run(subscriberId, weekStart, weekEnd, JSON.stringify(earningsSummary));
  countWrite();
  return result.lastInsertRowid;
}

export function getDigestHistory(subscriberId, limit = 10, offset = 0) {
  return db
    .prepare(`
      SELECT * FROM email_digest_log
      WHERE subscriberId = ?
      ORDER BY sentAt DESC
      LIMIT ? OFFSET ?
    `)
    .all(subscriberId, limit, offset);
}

export function getEarningsForWeek(walletAddress, weekStart, weekEnd) {
  const payouts = db
    .prepare(`
      SELECT
        dp.contractId,
        dp.collaboratorAddress,
        dp.amountReceived,
        t.timestamp
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE dp.collaboratorAddress = ?
        AND t.status = 'confirmed'
        AND t.timestamp BETWEEN ? AND ?
      ORDER BY t.timestamp DESC
    `)
    .all(walletAddress, weekStart, weekEnd);

  if (payouts.length === 0) {
    return {
      totalEarned: 0,
      payoutCount: 0,
      contracts: [],
      topContract: null,
    };
  }

  let totalEarned = 0;
  const contractMap = {};

  for (const payout of payouts) {
    const amount = parseFloat(payout.amountReceived) || 0;
    totalEarned += amount;

    if (!contractMap[payout.contractId]) {
      contractMap[payout.contractId] = { contractId: payout.contractId, totalEarned: 0, payoutCount: 0 };
    }
    contractMap[payout.contractId].totalEarned += amount;
    contractMap[payout.contractId].payoutCount += 1;
  }

  const contracts = Object.values(contractMap).sort((a, b) => b.totalEarned - a.totalEarned);

  return {
    totalEarned,
    payoutCount: payouts.length,
    contracts,
    topContract: contracts[0] ?? null,
  };
}
