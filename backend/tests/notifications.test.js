import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const mockGetNotifications = jest.fn();
const mockGetUnreadNotificationCount = jest.fn();
const mockMarkNotificationRead = jest.fn();
const mockMarkAllNotificationsRead = jest.fn();
const mockDeleteNotification = jest.fn();
const mockCreateSystemNotification = jest.fn();
const mockGetNotificationPreference = jest.fn();
const mockUpsertNotificationPreference = jest.fn();

await jest.unstable_mockModule("../src/database/notifications.js", () => ({
  getNotifications: mockGetNotifications,
  getUnreadNotificationCount: mockGetUnreadNotificationCount,
  markNotificationRead: mockMarkNotificationRead,
  markAllNotificationsRead: mockMarkAllNotificationsRead,
  deleteNotification: mockDeleteNotification,
  createSystemNotification: mockCreateSystemNotification,
  getNotificationPreference: mockGetNotificationPreference,
  upsertNotificationPreference: mockUpsertNotificationPreference,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 9),
}));

await jest.unstable_mockModule("../src/websocket.js", () => ({
  sendNotification: jest.fn(),
}));

import express from "express";
const { notificationsRouter } = await import("../src/routes/notifications.js");

const app = express();
app.use(express.json());
app.use("/api/v1/notifications", notificationsRouter);

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

describe("Notifications - CRUD", () => {
  beforeEach(() => {
    mockGetNotifications.mockReturnValue([]);
    mockGetUnreadNotificationCount.mockReturnValue(0);
  });

  test("GET /:walletAddress returns notifications", async () => {
    mockGetNotifications.mockReturnValue([{ id: 1, walletAddress: WALLET, type: "distribution_confirmed", title: "Distribution Confirmed", read: 0 }]);
    mockGetUnreadNotificationCount.mockReturnValue(1);

    const res = await request(app).get(`/api/v1/notifications/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.unreadCount).toBe(1);
  });

  test("GET /:walletAddress/unread-count returns count", async () => {
    mockGetUnreadNotificationCount.mockReturnValue(3);
    const res = await request(app).get(`/api/v1/notifications/${WALLET}/unread-count`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
  });

  test("POST /:id/read marks notification as read", async () => {
    const res = await request(app).post("/api/v1/notifications/1/read");
    expect(res.status).toBe(200);
    expect(mockMarkNotificationRead).toHaveBeenCalledWith(1);
  });

  test("POST /read-all/:walletAddress marks all as read", async () => {
    const res = await request(app).post(`/api/v1/notifications/read-all/${WALLET}`);
    expect(res.status).toBe(200);
    expect(mockMarkAllNotificationsRead).toHaveBeenCalledWith(WALLET);
  });

  test("DELETE /:id deletes notification", async () => {
    const res = await request(app).delete("/api/v1/notifications/1");
    expect(res.status).toBe(200);
    expect(mockDeleteNotification).toHaveBeenCalledWith(1);
  });
});

describe("Notifications - Send", () => {
  test("POST /send creates notification", async () => {
    mockCreateSystemNotification.mockReturnValue({ id: 1, walletAddress: WALLET, type: "test", title: "Test" });
    const res = await request(app)
      .post("/api/v1/notifications/send")
      .send({ walletAddress: WALLET, type: "distribution_confirmed", title: "Payment Received", message: "You received 100 XLM" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("POST /send rejects missing required fields", async () => {
    const res = await request(app)
      .post("/api/v1/notifications/send")
      .send({ type: "test" });
    expect(res.status).toBe(400);
  });
});

describe("Notifications - Preferences", () => {
  test("GET /preferences/:walletAddress returns preferences", async () => {
    mockGetNotificationPreference.mockReturnValue({ walletAddress: WALLET, email_enabled: 1, in_app_enabled: 1 });
    const res = await request(app).get(`/api/v1/notifications/preferences/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email_enabled).toBe(1);
  });

  test("POST /preferences saves preferences", async () => {
    mockGetNotificationPreference.mockReturnValue({ walletAddress: WALLET, email_enabled: 0, in_app_enabled: 1 });
    const res = await request(app)
      .post("/api/v1/notifications/preferences")
      .send({ walletAddress: WALLET, email_enabled: false, in_app_enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("POST /preferences rejects missing walletAddress", async () => {
    const res = await request(app)
      .post("/api/v1/notifications/preferences")
      .send({ email_enabled: true });
    expect(res.status).toBe(400);
  });
});

describe("Notifications - Connection Handling", () => {
  test("returns empty list for wallet with no notifications", async () => {
    mockGetNotifications.mockReturnValue([]);
    mockGetUnreadNotificationCount.mockReturnValue(0);

    const res = await request(app).get(`/api/v1/notifications/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  test("unread count is zero when all notifications are read", async () => {
    mockGetNotifications.mockReturnValue([{ id: 1, walletAddress: WALLET, type: "test", title: "Test", read: 1 }]);
    mockGetUnreadNotificationCount.mockReturnValue(0);

    const res = await request(app).get(`/api/v1/notifications/${WALLET}`);
    expect(res.body.unreadCount).toBe(0);
  });
});
