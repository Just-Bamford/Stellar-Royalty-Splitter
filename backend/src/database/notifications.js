import { db, countWrite } from "./core.js";

export const NOTIFICATION_TYPES = [
  "distribution_confirmed",
  "distribution_completed",
  "payment_received",
  "payment_failed",
  "dispute_created",
  "dispute_resolved",
  "reputation_changed",
  "governance_proposal",
  "security_alert",
  "system",
  "warning",
];

export const NOTIFICATION_CHANNELS = ["email", "sms", "push", "in_app"];

export const FREQUENCY_OPTIONS = ["immediate", "daily_digest", "weekly_digest"];

export const DEFAULT_CHANNEL_PREFERENCES = {
  distribution_confirmed: { email: false, sms: false, push: false, in_app: true },
  distribution_completed: { email: true, sms: false, push: false, in_app: true },
  payment_received: { email: false, sms: false, push: false, in_app: true },
  payment_failed: { email: true, sms: true, push: true, in_app: true },
  dispute_created: { email: true, sms: true, push: true, in_app: true },
  dispute_resolved: { email: true, sms: false, push: false, in_app: true },
  reputation_changed: { email: false, sms: false, push: false, in_app: true },
  governance_proposal: { email: true, sms: false, push: true, in_app: true },
  security_alert: { email: true, sms: true, push: true, in_app: true },
  system: { email: false, sms: false, push: false, in_app: true },
  warning: { email: false, sms: false, push: true, in_app: true },
};

export const DEFAULT_QUIET_HOURS = { enabled: false, start: 21, end: 9 };

function parseChannelPrefs(raw) {
  try {
    return raw ? JSON.parse(raw) : { ...DEFAULT_CHANNEL_PREFERENCES };
  } catch {
    return { ...DEFAULT_CHANNEL_PREFERENCES };
  }
}

export function createNotification(notification) {
  const stmt = db.prepare(`
    INSERT INTO notifications (walletAddress, type, title, message, data, archived, channel)
    VALUES (?, ?, ?, ?, ?, 0, COALESCE(?, 'in_app'))
  `);
  const result = stmt.run(
    notification.walletAddress,
    notification.type,
    notification.title,
    notification.message,
    notification.data ? JSON.stringify(notification.data) : null,
    notification.channel ?? "in_app"
  );
  countWrite();
  return { id: result.lastInsertRowid, ...notification, read: 0, archived: 0 };
}

export function getNotifications(walletAddress, limit = 50, offset = 0) {
  return db
    .prepare(
      `SELECT * FROM notifications
       WHERE walletAddress = ? AND archived = 0
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(walletAddress, limit, offset);
}

export function getArchivedNotifications(walletAddress, limit = 50, offset = 0) {
  return db
    .prepare(
      `SELECT * FROM notifications
       WHERE walletAddress = ? AND archived = 1
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(walletAddress, limit, offset);
}

export function getUnreadNotificationCount(walletAddress) {
  const result = db
    .prepare(
      "SELECT COUNT(*) as count FROM notifications WHERE walletAddress = ? AND read = 0 AND archived = 0"
    )
    .get(walletAddress);
  return result?.count ?? 0;
}

export function getUnreadCountByType(walletAddress) {
  const rows = db
    .prepare(
      `SELECT type, COUNT(*) as count FROM notifications
       WHERE walletAddress = ? AND read = 0 AND archived = 0
       GROUP BY type`
    )
    .all(walletAddress);
  return rows.reduce((acc, row) => {
    acc[row.type] = row.count;
    return acc;
  }, {});
}

export function markNotificationRead(notificationId) {
  db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(notificationId);
  countWrite();
}

export function markNotificationUnread(notificationId) {
  db.prepare("UPDATE notifications SET read = 0 WHERE id = ?").run(notificationId);
  countWrite();
}

export function markAllNotificationsRead(walletAddress) {
  db.prepare(
    "UPDATE notifications SET read = 1 WHERE walletAddress = ? AND read = 0 AND archived = 0"
  ).run(walletAddress);
  countWrite();
}

export function archiveNotification(notificationId) {
  db.prepare("UPDATE notifications SET archived = 1 WHERE id = ?").run(notificationId);
  countWrite();
}

export function unarchiveNotification(notificationId) {
  db.prepare("UPDATE notifications SET archived = 0 WHERE id = ?").run(notificationId);
  countWrite();
}

export function deleteNotification(notificationId) {
  db.prepare("DELETE FROM notifications WHERE id = ?").run(notificationId);
  countWrite();
}

export function searchNotifications(walletAddress, query, limit = 50, offset = 0) {
  const pattern = `%${query}%`;
  return db
    .prepare(
      `SELECT * FROM notifications
       WHERE walletAddress = ? AND archived = 0
         AND (title LIKE ? OR message LIKE ? OR type LIKE ?)
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(walletAddress, pattern, pattern, pattern, limit, offset);
}

export function getNotificationsByType(walletAddress, type, limit = 50, offset = 0) {
  return db
    .prepare(
      `SELECT * FROM notifications
       WHERE walletAddress = ? AND type = ? AND archived = 0
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(walletAddress, type, limit, offset);
}

export function getNotificationPreference(walletAddress) {
  const result = db
    .prepare("SELECT * FROM notification_preferences WHERE walletAddress = ?")
    .get(walletAddress);
  return result ?? {
    walletAddress,
    email_enabled: 1,
    in_app_enabled: 1,
    sms_enabled: 0,
    push_enabled: 0,
    notify_distribution: 1,
    notify_payment: 1,
    notify_failure: 1,
    notify_hold: 1,
    notify_dispute_created: 1,
    notify_dispute_resolved: 1,
    notify_reputation_changed: 1,
    notify_governance: 1,
    notify_security_alert: 1,
    frequency: "immediate",
    quiet_hours_enabled: 0,
    quiet_hours_start: 21,
    quiet_hours_end: 9,
    channel_preferences: JSON.stringify({ ...DEFAULT_CHANNEL_PREFERENCES }),
  };
}

export function upsertNotificationPreference(prefs) {
  const channelPrefs =
    typeof prefs.channel_preferences === "string"
      ? prefs.channel_preferences
      : JSON.stringify(prefs.channel_preferences ?? DEFAULT_CHANNEL_PREFERENCES);

  const existing = db
    .prepare("SELECT id FROM notification_preferences WHERE walletAddress = ?")
    .get(prefs.walletAddress);

  if (existing) {
    db.prepare(
      `UPDATE notification_preferences SET
         email_enabled = ?, in_app_enabled = ?, sms_enabled = ?, push_enabled = ?,
         notify_distribution = ?, notify_payment = ?, notify_failure = ?, notify_hold = ?,
         notify_dispute_created = ?, notify_dispute_resolved = ?,
         notify_reputation_changed = ?, notify_governance = ?, notify_security_alert = ?,
         frequency = ?, quiet_hours_enabled = ?, quiet_hours_start = ?, quiet_hours_end = ?,
         channel_preferences = ?, updated_at = CURRENT_TIMESTAMP
       WHERE walletAddress = ?`
    ).run(
      prefs.email_enabled ? 1 : 0,
      prefs.in_app_enabled ? 1 : 0,
      prefs.sms_enabled ? 1 : 0,
      prefs.push_enabled ? 1 : 0,
      prefs.notify_distribution ? 1 : 0,
      prefs.notify_payment ? 1 : 0,
      prefs.notify_failure ? 1 : 0,
      prefs.notify_hold ? 1 : 0,
      prefs.notify_dispute_created ? 1 : 0,
      prefs.notify_dispute_resolved ? 1 : 0,
      prefs.notify_reputation_changed ? 1 : 0,
      prefs.notify_governance ? 1 : 0,
      prefs.notify_security_alert ? 1 : 0,
      prefs.frequency ?? "immediate",
      prefs.quiet_hours_enabled ? 1 : 0,
      prefs.quiet_hours_start ?? 21,
      prefs.quiet_hours_end ?? 9,
      channelPrefs,
      prefs.walletAddress
    );
  } else {
    db.prepare(
      `INSERT INTO notification_preferences
         (walletAddress, email_enabled, in_app_enabled, sms_enabled, push_enabled,
          notify_distribution, notify_payment, notify_failure, notify_hold,
          notify_dispute_created, notify_dispute_resolved, notify_reputation_changed,
          notify_governance, notify_security_alert, frequency,
          quiet_hours_enabled, quiet_hours_start, quiet_hours_end, channel_preferences)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      prefs.walletAddress,
      prefs.email_enabled ? 1 : 0,
      prefs.in_app_enabled ? 1 : 0,
      prefs.sms_enabled ? 1 : 0,
      prefs.push_enabled ? 1 : 0,
      prefs.notify_distribution ? 1 : 0,
      prefs.notify_payment ? 1 : 0,
      prefs.notify_failure ? 1 : 0,
      prefs.notify_hold ? 1 : 0,
      prefs.notify_dispute_created ? 1 : 0,
      prefs.notify_dispute_resolved ? 1 : 0,
      prefs.notify_reputation_changed ? 1 : 0,
      prefs.notify_governance ? 1 : 0,
      prefs.notify_security_alert ? 1 : 0,
      prefs.frequency ?? "immediate",
      prefs.quiet_hours_enabled ? 1 : 0,
      prefs.quiet_hours_start ?? 21,
      prefs.quiet_hours_end ?? 9,
      channelPrefs
    );
  }
  countWrite();
  return getNotificationPreference(prefs.walletAddress);
}

export function getChannelPreferences(walletAddress) {
  const pref = getNotificationPreference(walletAddress);
  return parseChannelPrefs(pref.channel_preferences);
}

export function getQuietHours(walletAddress) {
  const pref = getNotificationPreference(walletAddress);
  return {
    enabled: Boolean(pref.quiet_hours_enabled),
    start: pref.quiet_hours_start ?? 21,
    end: pref.quiet_hours_end ?? 9,
  };
}

export function resolveFrequency(frequency) {
  const valid = FREQUENCY_OPTIONS;
  return valid.includes(frequency) ? frequency : "immediate";
}

export function resolveQuietHours(startHour, endHour) {
  const start = Math.max(0, Math.min(23, parseInt(startHour) ?? 21));
  const end = Math.max(0, Math.min(23, parseInt(endHour) ?? 9));
  return { start, end };
}

export function isWithinQuietHours(date, startHour, endHour) {
  const hour = date.getHours();
  if (startHour <= endHour) {
    return hour >= startHour && hour < endHour;
  }
  return hour >= startHour || hour < endHour;
}

function typeToColumn(type) {
  const mapping = {
    distribution_confirmed: "notify_distribution",
    distribution_completed: "notify_distribution",
    payment_received: "notify_payment",
    payment_failed: "notify_failure",
    dispute_created: "notify_dispute_created",
    dispute_resolved: "notify_dispute_resolved",
    reputation_changed: "notify_reputation_changed",
    governance_proposal: "notify_governance",
    security_alert: "notify_security_alert",
    system: null,
    warning: null,
  };
  return mapping[type] ?? null;
}

export function shouldSendNotification(walletAddress, type, now = new Date()) {
  const pref = getNotificationPreference(walletAddress);

  const column = typeToColumn(type);
  if (column && !pref[column]) return false;

  if (pref.quiet_hours_enabled) {
    const startHour = pref.quiet_hours_start ?? 21;
    const endHour = pref.quiet_hours_end ?? 9;
    if (isWithinQuietHours(now, startHour, endHour)) return false;
  }

  return true;
}

export function createSystemNotification(walletAddress, type, title, message, data, channel) {
  const notification = createNotification({
    walletAddress,
    type,
    title,
    message,
    data,
    channel: channel ?? "in_app",
  });
  return notification;
}
