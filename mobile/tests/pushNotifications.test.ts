import { describe, it, expect, beforeEach } from "vitest";
import { pushNotificationService } from "../src/services/pushNotifications";

describe("Push Notification Service", () => {
  beforeEach(() => {
    pushNotificationService.clearAll();
  });

  it("registers for device push token", async () => {
    const token = await pushNotificationService.registerForPushNotifications();
    expect(token).toBeDefined();
    expect(token.length).toBeGreaterThan(0);
  });

  it("receives distribution completed alert", () => {
    const notif = pushNotificationService.receiveNotification({
      type: "distribution_completed",
      title: "💰 Royalty Payout",
      body: "750 XLM deposited into your account.",
    });

    expect(notif.type).toBe("distribution_completed");
    expect(notif.read).toBe(false);

    const list = pushNotificationService.getNotifications();
    expect(list.length).toBe(1);
  });

  it("receives reputation tier change and dispute update alerts", () => {
    pushNotificationService.receiveNotification({
      type: "reputation_change",
      title: "⭐ Tier Upgrade",
      body: "Upgraded to Gold collaborator.",
    });

    pushNotificationService.receiveNotification({
      type: "dispute_update",
      title: "⚖️ Dispute Settled",
      body: "Dispute resolved successfully.",
    });

    expect(pushNotificationService.getUnreadCount()).toBe(2);
  });

  it("marks notifications as read and clears list", () => {
    const notif = pushNotificationService.receiveNotification({
      type: "distribution_completed",
      title: "Payout",
      body: "100 XLM",
    });

    pushNotificationService.markAsRead(notif.id);
    expect(pushNotificationService.getUnreadCount()).toBe(0);

    pushNotificationService.clearAll();
    expect(pushNotificationService.getNotifications().length).toBe(0);
  });
});
