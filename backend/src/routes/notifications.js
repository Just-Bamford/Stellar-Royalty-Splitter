import { Router } from "express";
import { sendError } from "../error-response.js";
import {
  getNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  getNotificationPreference,
  upsertNotificationPreference,
  createSystemNotification,
} from "../database/notifications.js";
import { sendNotification } from "../websocket.js";

export const notificationsRouter = Router();

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

notificationsRouter.post("/:id/read", (req, res) => {
  try {
    markNotificationRead(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, "mark_read_error", err.message);
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

notificationsRouter.delete("/:id", (req, res) => {
  try {
    deleteNotification(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    sendError(res, 500, "delete_error", err.message);
  }
});

notificationsRouter.post("/send", (req, res) => {
  try {
    const { walletAddress, type, title, message, data } = req.body;
    if (!walletAddress || !type || !title) {
      return sendError(res, 400, "validation_error", "walletAddress, type, and title are required");
    }
    const notification = createSystemNotification(walletAddress, type, title, message, data);
    sendNotification(walletAddress, notification);
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
    const { walletAddress, email_enabled, in_app_enabled, sms_enabled, notify_distribution, notify_payment, notify_failure, notify_hold } = req.body;
    if (!walletAddress) {
      return sendError(res, 400, "validation_error", "walletAddress is required");
    }
    const prefs = upsertNotificationPreference({
      walletAddress,
      email_enabled: email_enabled ?? true,
      in_app_enabled: in_app_enabled ?? true,
      sms_enabled: sms_enabled ?? false,
      notify_distribution: notify_distribution ?? true,
      notify_payment: notify_payment ?? true,
      notify_failure: notify_failure ?? true,
      notify_hold: notify_hold ?? true,
    });
    res.json({ success: true, data: prefs });
  } catch (err) {
    sendError(res, 500, "prefs_save_error", err.message);
  }
});
