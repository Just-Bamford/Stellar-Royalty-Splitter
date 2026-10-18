import { Router } from "express";
import { sendError } from "../error-response.js";
import {
  getNotifications,
  getArchivedNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markNotificationUnread,
  markAllNotificationsRead,
  archiveNotification,
  unarchiveNotification,
  deleteNotification,
  searchNotifications,
  getNotificationsByType,
  getNotificationPreference,
  upsertNotificationPreference,
  createSystemNotification,
  shouldSendNotification,
  NOTIFICATION_TYPES,
} from "../database/notifications.js";
import { sendNotification } from "../websocket.js";
import { sendEventSms } from "../services/sms-notifications.js";

export const notificationsRouter = Router();

// Event types this generic /send endpoint also fans out to SMS for (#927),
// mapped to the params each SMS template builder expects.
const SMS_EVENT_PARAM_KEYS = {
  large_payout: ["amount", "contractId"],
  dispute_opened: ["ticketId"],
  payment_failed: ["contractId", "reason"],
};

notificationsRouter.get("/:walletAddress", (req, res) => {
  try {
    const limit = parseInt(req.query.limit ?? "50");
    const offset = parseInt(req.query.offset ?? "0");
    const notifications = getNotifications(req.params.walletAddress, limit, offset);
    const unreadCount = getUnreadNotificationCount(req.params.walletAddress);
    res.json({ success: true, data: notifications, unreadCount });
  } catch (err) {
    sendError(res, 500, "notifications_fetch_error", err.message);
  }
});

notificationsRouter.get("/:walletAddress/unread-count", (req, res) => {
  try {
    const count = getUnreadNotificationCount(req.params.walletAddress);
    res.json({ success: true, count });
  } catch (err) {
    sendError(res, 500, "unread_count_error", err.message);
  }
});

notificationsRouter.get("/:walletAddress/by-type/:type", (req, res) => {
  try {
    const { walletAddress, type } = req.params;
    const limit = parseInt(req.query.limit ?? "50");
    const offset = parseInt(req.query.offset ?? "0");

    if (!NOTIFICATION_TYPES.includes(type)) {
      return sendError(
        res,
        400,
        "invalid_type",
        `Invalid notification type. Valid types: ${NOTIFICATION_TYPES.join(", ")}`
      );
    }

    const notifications = getNotificationsByType(walletAddress, type, limit, offset);
    res.json({ success: true, data: notifications });
  } catch (err) {
    sendError(res, 500, "notifications_by_type_error", err.message);
  }
});

notificationsRouter.get("/:walletAddress/search", (req, res) => {
  try {
    const { walletAddress } = req.params;
    const query = req.query.q;
    const limit = parseInt(req.query.limit ?? "50");
    const offset = parseInt(req.query.offset ?? "0");

    if (!query || typeof query !== "string") {
      return sendError(res, 400, "missing_query", "Search query parameter 'q' is required");
    }

    const results = searchNotifications(walletAddress, query, limit, offset);
    res.json({ success: true, data: results, count: results.length });
  } catch (err) {
    sendError(res, 500, "search_error", err.message);
  }
});

notificationsRouter.get("/:walletAddress/unread-by-type", (req, res) => {
  try {
    const counts = {};
    for (const type of NOTIFICATION_TYPES) {
      const count = getNotificationsByType(req.params.walletAddress, type, 1, 0).filter(
        (n) => !n.read
      ).length;
      if (count > 0) counts[type] = count;
    }
    res.json({ success: true, data: counts });
  } catch (err) {
    sendError(res, 500, "unread_by_type_error", err.message);
  }
});

notificationsRouter.post("/:id/read", (req, res) => {
  try {
    markNotificationRead(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, "mark_read_error", err.message);
  }
});

notificationsRouter.post("/:id/unread", (req, res) => {
  try {
    markNotificationUnread(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, "mark_unread_error", err.message);
  }
});

notificationsRouter.post("/read-all/:walletAddress", (req, res) => {
  try {
    markAllNotificationsRead(req.params.walletAddress);
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, "mark_all_read_error", err.message);
  }
});

notificationsRouter.post("/:id/archive", (req, res) => {
  try {
    archiveNotification(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, "archive_error", err.message);
  }
});

notificationsRouter.post("/:id/unarchive", (req, res) => {
  try {
    unarchiveNotification(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, "unarchive_error", err.message);
  }
});

notificationsRouter.get("/:walletAddress/archived", (req, res) => {
  try {
    const limit = parseInt(req.query.limit ?? "50");
    const offset = parseInt(req.query.offset ?? "0");
    const notifications = getArchivedNotifications(req.params.walletAddress, limit, offset);
    res.json({ success: true, data: notifications });
  } catch (err) {
    sendError(res, 500, "archived_fetch_error", err.message);
  }
});

notificationsRouter.delete("/:id", (req, res) => {
  try {
    deleteNotification(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, "delete_error", err.message);
  }
});

notificationsRouter.post("/send", async (req, res) => {
  try {
    const { walletAddress, type, title, message, data, channel } = req.body;
    if (!walletAddress || !type || !title) {
      return sendError(
        res,
        400,
        "validation_error",
        "walletAddress, type, and title are required"
      );
    }

    if (!shouldSendNotification(walletAddress, type)) {
      return res.json({
        success: true,
        data: null,
        suppressed: true,
        reason: "User preference or quiet hours",
      });
    }

    const notification = createSystemNotification(walletAddress, type, title, message, data, channel);
    sendNotification(walletAddress, notification);

    const paramKeys = SMS_EVENT_PARAM_KEYS[type];
    if (paramKeys) {
      const templateParams = Object.fromEntries(
        paramKeys.map((key) => [key, data?.[key]])
      );
      await sendEventSms(walletAddress, type, templateParams);
    }

    res.json({ success: true, data: notification });
  } catch (err) {
    sendError(res, 500, "send_error", err.message);
  }
});

notificationsRouter.get("/preferences/:walletAddress", (req, res) => {
  try {
    const prefs = getNotificationPreference(req.params.walletAddress);
    res.json({ success: true, data: prefs });
  } catch (err) {
    sendError(res, 500, "prefs_fetch_error", err.message);
  }
});

notificationsRouter.post("/preferences", (req, res) => {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress) {
      return sendError(res, 400, "validation_error", "walletAddress is required");
    }
    const prefs = upsertNotificationPreference({
      walletAddress,
      email_enabled: req.body.email_enabled ?? true,
      in_app_enabled: req.body.in_app_enabled ?? true,
      sms_enabled: req.body.sms_enabled ?? false,
      push_enabled: req.body.push_enabled ?? false,
      notify_distribution: req.body.notify_distribution ?? true,
      notify_payment: req.body.notify_payment ?? true,
      notify_failure: req.body.notify_failure ?? true,
      notify_hold: req.body.notify_hold ?? true,
      notify_dispute_created: req.body.notify_dispute_created ?? true,
      notify_dispute_resolved: req.body.notify_dispute_resolved ?? true,
      notify_reputation_changed: req.body.notify_reputation_changed ?? false,
      notify_governance: req.body.notify_governance ?? true,
      notify_security_alert: req.body.notify_security_alert ?? true,
      frequency: req.body.frequency ?? "immediate",
      quiet_hours_enabled: req.body.quiet_hours_enabled ?? false,
      quiet_hours_start: req.body.quiet_hours_start ?? 21,
      quiet_hours_end: req.body.quiet_hours_end ?? 9,
      channel_preferences: req.body.channel_preferences
        ? JSON.stringify(req.body.channel_preferences)
        : undefined,
    });
    res.json({ success: true, data: prefs });
  } catch (err) {
    sendError(res, 500, "prefs_save_error", err.message);
  }
});
