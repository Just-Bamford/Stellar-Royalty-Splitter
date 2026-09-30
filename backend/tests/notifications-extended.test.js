import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const mockGetNotifications = jest.fn();
const mockGetArchivedNotifications = jest.fn();
const mockGetUnreadNotificationCount = jest.fn();
const mockMarkNotificationRead = jest.fn();
const mockMarkNotificationUnread = jest.fn();
const mockMarkAllNotificationsRead = jest.fn();
const mockArchiveNotification = jest.fn();
const mockUnarchiveNotification = jest.fn();
const mockDeleteNotification = jest.fn();
const mockSearchNotifications = jest.fn();
const mockGetNotificationsByType = jest.fn();
const mockGetNotificationPreference = jest.fn();
const mockUpsertNotificationPreference = jest.fn();
const mockGetChannelPreferences = jest.fn();
const mockGetQuietHours = jest.fn();
const mockShouldSendNotification = jest.fn();
const mockCreateSystemNotification = jest.fn();

const mockSendNotification = jest.fn();
const mockSendEventSms = jest.fn(() => ({ attempted: false, reason: "not_opted_in" }));

jest.unstable_mockModule("../src/database/notifications.js", () => ({
  db: { prepare: jest.fn(), exec: jest.fn() },
  countWrite: jest.fn(),
  getNotifications: mockGetNotifications,
  getArchivedNotifications: mockGetArchivedNotifications,
  getUnreadNotificationCount: mockGetUnreadNotificationCount,
  getUnreadCountByType: jest.fn(),
  markNotificationRead: mockMarkNotificationRead,
  markNotificationUnread: mockMarkNotificationUnread,
  markAllNotificationsRead: mockMarkAllNotificationsRead,
  archiveNotification: mockArchiveNotification,
  unarchiveNotification: mockUnarchiveNotification,
  deleteNotification: mockDeleteNotification,
  searchNotifications: mockSearchNotifications,
  getNotificationsByType: mockGetNotificationsByType,
  getNotificationPreference: mockGetNotificationPreference,
  upsertNotificationPreference: mockUpsertNotificationPreference,
  getChannelPreferences: mockGetChannelPreferences,
  getQuietHours: mockGetQuietHours,
  resolveFrequency: jest.fn((f) => f ?? "immediate"),
  resolveQuietHours: jest.fn((s, e) => ({ start: s ?? 21, end: e ?? 9 })),
  isWithinQuietHours: jest.fn(),
  shouldSendNotification: mockShouldSendNotification,
  createNotification: jest.fn(),
  createSystemNotification: mockCreateSystemNotification,
  NOTIFICATION_TYPES: [
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
  ],
  NOTIFICATION_CHANNELS: ["email", "sms", "push", "in_app"],
  FREQUENCY_OPTIONS: ["immediate", "daily_digest", "weekly_digest"],
  DEFAULT_CHANNEL_PREFERENCES: {},
  DEFAULT_QUIET_HOURS: { enabled: false, start: 21, end: 9 },
}));

jest.unstable_mockModule("../src/database/core.js", () => ({
  db: { prepare: jest.fn(), exec: jest.fn() },
  countWrite: jest.fn(),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 24),
  checkpointDatabase: jest.fn(),
  closeDatabase: jest.fn(),
  checkDatabase: jest.fn(),
  pruneHealthHistory: jest.fn(),
  recordHealthSnapshot: jest.fn(),
  getHealthHistory: jest.fn(),
  getSLAStats: jest.fn(),
}));

jest.unstable_mockModule("../../shared/stellar-address.js", () => ({
  isValidStellarAccountAddress: (addr) => /^G[A-Z2-7]{55}$/.test(addr),
}));

jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 24),
}));

jest.unstable_mockModule("../src/websocket.js", () => ({
  sendNotification: mockSendNotification,
  initializeWebSocket: jest.fn(),
  broadcastToContract: jest.fn(),
}));

jest.unstable_mockModule("../src/services/sms-notifications.js", () => ({
  sendEventSms: mockSendEventSms,
}));

import express from "express";
const { notificationsRouter } = await import("../src/routes/notifications.js");
const { granularPreferencesRouter } = await import("../src/routes/notifications/preferences.js");

const app = express();
app.use(express.json());
app.use("/api/v1/notifications", notificationsRouter);
app.use("/api/v1/notifications/preferences", granularPreferencesRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

describe("Notifications - Extended CRUD", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetNotifications.mockReturnValue([]);
    mockGetArchivedNotifications.mockReturnValue([]);
    mockGetUnreadNotificationCount.mockReturnValue(0);
    mockShouldSendNotification.mockReturnValue(true);
  });

  describe("Archive operations", () => {
    test("POST /:id/archive archives a notification", async () => {
      const res = await request(app).post("/api/v1/notifications/1/archive");
      expect(res.status).toBe(200);
      expect(mockArchiveNotification).toHaveBeenCalledWith(1);
    });

    test("POST /:id/unarchive unarchives a notification", async () => {
      const res = await request(app).post("/api/v1/notifications/1/unarchive");
      expect(res.status).toBe(200);
      expect(mockUnarchiveNotification).toHaveBeenCalledWith(1);
    });

    test("GET /:walletAddress/archived returns archived notifications", async () => {
      mockGetArchivedNotifications.mockReturnValue([
        { id: 1, walletAddress: WALLET, type: "distribution_completed", title: "Completed", archived: 1, read: 0 },
      ]);

      const res = await request(app).get(`/api/v1/notifications/${WALLET}/archived`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(mockGetArchivedNotifications).toHaveBeenCalledWith(WALLET, 50, 0);
    });
  });

  describe("Mark as unread", () => {
    test("POST /:id/unread marks notification as unread", async () => {
      const res = await request(app).post("/api/v1/notifications/1/unread");
      expect(res.status).toBe(200);
      expect(mockMarkNotificationUnread).toHaveBeenCalledWith(1);
    });
  });

  describe("Search", () => {
    test("GET /:walletAddress/search returns matching notifications", async () => {
      mockSearchNotifications.mockReturnValue([
        { id: 1, walletAddress: WALLET, type: "distribution_completed", title: "Payment", message: "Payment received" },
      ]);

      const res = await request(app).get(`/api/v1/notifications/${WALLET}/search?q=payment`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(mockSearchNotifications).toHaveBeenCalledWith(WALLET, "payment", 50, 0);
    });

    test("GET /:walletAddress/search rejects missing query", async () => {
      const res = await request(app).get(`/api/v1/notifications/${WALLET}/search`);
      expect(res.status).toBe(400);
    });

    test("GET /:walletAddress/search supports limit and offset", async () => {
      mockSearchNotifications.mockReturnValue([]);

      const res = await request(app).get(
        `/api/v1/notifications/${WALLET}/search?q=test&limit=10&offset=5`
      );
      expect(res.status).toBe(200);
      expect(mockSearchNotifications).toHaveBeenCalledWith(WALLET, "test", 10, 5);
    });
  });

  describe("Notifications by type", () => {
    test("GET /:walletAddress/by-type/:type returns notifications of the given type", async () => {
      mockGetNotificationsByType.mockReturnValue([
        { id: 1, walletAddress: WALLET, type: "dispute_created", title: "Dispute opened" },
      ]);

      const res = await request(app).get(`/api/v1/notifications/${WALLET}/by-type/dispute_created`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
    });

    test("GET /:walletAddress/by-type/:type rejects invalid type", async () => {
      const res = await request(app).get(`/api/v1/notifications/${WALLET}/by-type/invalid_type`);
      expect(res.status).toBe(400);
    });
  });

  describe("Unread by type", () => {
    test("GET /:walletAddress/unread-by-type returns unread counts by type", async () => {
      mockGetNotificationsByType.mockImplementation((walletAddress, type) => {
        if (type === "dispute_created") {
          return [
            { id: 1, walletAddress, type, title: "Dispute", read: 0 },
            { id: 2, walletAddress, type, title: "Read dispute", read: 1 },
          ];
        }
        return [];
      });

      const res = await request(app).get(`/api/v1/notifications/${WALLET}/unread-by-type`);
      expect(res.status).toBe(200);
      expect(res.body.data.dispute_created).toBe(1);
    });
  });

  describe("Send with preference checking", () => {
    test("POST /send respects shouldSendNotification (suppressed)", async () => {
      mockShouldSendNotification.mockReturnValue(false);

      const res = await request(app)
        .post("/api/v1/notifications/send")
        .send({
          walletAddress: WALLET,
          type: "system",
          title: "Test",
          message: "Test message",
        });

      expect(res.status).toBe(200);
      expect(res.body.suppressed).toBe(true);
      expect(mockCreateSystemNotification).not.toHaveBeenCalled();
    });

    test("POST /send creates notification when shouldSendNotification is true", async () => {
      mockCreateSystemNotification.mockReturnValue({ id: 1, walletAddress: WALLET, type: "system", title: "Test" });

      const res = await request(app)
        .post("/api/v1/notifications/send")
        .send({
          walletAddress: WALLET,
          type: "distribution_completed",
          title: "Distribution Complete",
          message: "Your distribution was processed",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockCreateSystemNotification).toHaveBeenCalled();
      expect(mockSendNotification).toHaveBeenCalled();
    });
  });
});

describe("Granular Preferences", () => {
  const prefsApp = express();
  prefsApp.use(express.json());
  prefsApp.use("/api/v1/notifications/preferences", granularPreferencesRouter);

  prefsApp.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err.message ?? "Internal server error" });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("GET /preferences/:walletAddress returns detailed preferences", async () => {
    mockGetNotificationPreference.mockReturnValue({
      walletAddress: WALLET,
      email_enabled: 1,
      in_app_enabled: 1,
      sms_enabled: 0,
      push_enabled: 0,
      notify_distribution: 1,
      notify_payment: 1,
      notify_failure: 0,
      notify_hold: 1,
      notify_dispute_created: 1,
      notify_dispute_resolved: 1,
      notify_reputation_changed: 0,
      notify_governance: 1,
      notify_security_alert: 1,
      frequency: "immediate",
      quiet_hours_enabled: 0,
      quiet_hours_start: 21,
      quiet_hours_end: 9,
    });

    mockGetChannelPreferences.mockReturnValue({
      distribution_confirmed: { email: false, sms: false, push: false, in_app: true },
    });

    mockGetQuietHours.mockReturnValue({ enabled: false, start: 21, end: 9 });

    const res = await request(prefsApp).get(`/api/v1/notifications/preferences/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.channels.email).toBe(true);
    expect(res.body.data.typeToggles.dispute_created).toBe(true);
    expect(res.body.data.typeToggles.reputation_changed).toBe(false);
    expect(res.body.data.frequency).toBe("immediate");
    expect(res.body.data.quietHours.enabled).toBe(false);
  });

  test("GET /preferences/:walletAddress rejects invalid address", async () => {
    const res = await request(prefsApp).get("/api/v1/notifications/preferences/invalid");
    expect(res.status).toBe(400);
  });

  test("POST /preferences saves new preferences", async () => {
    const savedPrefs = {
      walletAddress: WALLET,
      email_enabled: 1,
      in_app_enabled: 1,
      sms_enabled: 1,
      push_enabled: 0,
      notify_distribution: 1,
      notify_payment: 1,
      notify_failure: 1,
      notify_hold: 1,
      notify_dispute_created: 1,
      notify_dispute_resolved: 1,
      notify_reputation_changed: 0,
      notify_governance: 1,
      notify_security_alert: 1,
      frequency: "daily_digest",
      quiet_hours_enabled: 1,
      quiet_hours_start: 22,
      quiet_hours_end: 8,
      channel_preferences: '{}',
    };

    mockUpsertNotificationPreference.mockReturnValue(savedPrefs);

    const res = await request(prefsApp)
      .post("/api/v1/notifications/preferences")
      .send({
        walletAddress: WALLET,
        email_enabled: true,
        sms_enabled: true,
        notify_dispute_resolved: false,
        notify_reputation_changed: false,
        frequency: "daily_digest",
        quiet_hours_enabled: true,
        quiet_hours_start: 22,
        quiet_hours_end: 8,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockUpsertNotificationPreference).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: WALLET,
        frequency: "daily_digest",
        quiet_hours_enabled: true,
        quiet_hours_start: 22,
        quiet_hours_end: 8,
      })
    );
  });

  test("POST /preferences rejects missing walletAddress", async () => {
    const res = await request(prefsApp)
      .post("/api/v1/notifications/preferences")
      .send({ email_enabled: true });

    expect(res.status).toBe(400);
  });
});
