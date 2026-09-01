import { db, countWrite } from "./core.js";

export function createNotification(notification) {
  const stmt = db.prepare(`
    INSERT INTO notifications (walletAddress, type, title, message, data)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    notification.walletAddress,
    notification.type,
    notification.title,
    notification.message,
    notification.data ? JSON.stringify(notification.data) : null
  );
  countWrite();
  return { id: result.lastInsertRowid, ...notification, read: 0 };
}

export function getNotifications(walletAddress, limit = 50, offset = 0) {
  return db.prepare(`
    SELECT * FROM notifications 
    WHERE walletAddress = ? 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `).all(walletAddress, limit, offset);
}

export function getUnreadNotificationCount(walletAddress) {
  const result = db.prepare(
    "SELECT COUNT(*) as count FROM notifications WHERE walletAddress = ? AND read = 0"
  ).get(walletAddress);
  return result?.count ?? 0;
}

export function markNotificationRead(notificationId) {
  db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(notificationId);
  countWrite();
}

export function markAllNotificationsRead(walletAddress) {
  db.prepare("UPDATE notifications SET read = 1 WHERE walletAddress = ? AND read = 0").run(walletAddress);
  countWrite();
}

export function deleteNotification(notificationId) {
  db.prepare("DELETE FROM notifications WHERE id = ?").run(notificationId);
  countWrite();
}

export function getNotificationPreference(walletAddress) {
  const result = db.prepare("SELECT * FROM notification_preferences WHERE walletAddress = ?").get(walletAddress);
  return result ?? {
    walletAddress,
    email_enabled: 1,
    in_app_enabled: 1,
    sms_enabled: 0,
    notify_distribution: 1,
    notify_payment: 1,
    notify_failure: 1,
    notify_hold: 1,
  };
}

export function upsertNotificationPreference(prefs) {
  const existing = db.prepare("SELECT id FROM notification_preferences WHERE walletAddress = ?").get(prefs.walletAddress);
  if (existing) {
    db.prepare(`
      UPDATE notification_preferences SET
        email_enabled = ?, in_app_enabled = ?, sms_enabled = ?,
        notify_distribution = ?, notify_payment = ?, notify_failure = ?, notify_hold = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE walletAddress = ?
    `).run(
      prefs.email_enabled ? 1 : 0,
      prefs.in_app_enabled ? 1 : 0,
      prefs.sms_enabled ? 1 : 0,
      prefs.notify_distribution ? 1 : 0,
      prefs.notify_payment ? 1 : 0,
      prefs.notify_failure ? 1 : 0,
      prefs.notify_hold ? 1 : 0,
      prefs.walletAddress
    );
  } else {
    db.prepare(`
      INSERT INTO notification_preferences (walletAddress, email_enabled, in_app_enabled, sms_enabled, notify_distribution, notify_payment, notify_failure, notify_hold)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      prefs.walletAddress,
      prefs.email_enabled ? 1 : 0,
      prefs.in_app_enabled ? 1 : 0,
      prefs.sms_enabled ? 1 : 0,
      prefs.notify_distribution ? 1 : 0,
      prefs.notify_payment ? 1 : 0,
      prefs.notify_failure ? 1 : 0,
      prefs.notify_hold ? 1 : 0
    );
  }
  countWrite();
  return getNotificationPreference(prefs.walletAddress);
}

export function createSystemNotification(walletAddress, type, title, message, data) {
  return createNotification({ walletAddress, type, title, message, data });
}
