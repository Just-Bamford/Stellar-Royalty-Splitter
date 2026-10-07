/**
 * Push Notification Service
 * Manages APNS / FCM registration and handles alerts for distributions, reputation changes, and disputes.
 */

export type NotificationType =
  | "distribution_completed"
  | "reputation_change"
  | "dispute_update"
  | "system_alert";

export interface MobileNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, any>;
  timestamp: number;
  read: boolean;
}

class PushNotificationService {
  private notifications: MobileNotification[] = [
    {
      id: "notif-001",
      type: "distribution_completed",
      title: "💰 Distribution Completed",
      body: "You received 450.00 XLM from Contract CDLZ...4891.",
      timestamp: Date.now() - 3600000,
      read: false,
    },
    {
      id: "notif-002",
      type: "reputation_change",
      title: "⭐ Reputation Tier Updated",
      body: "Congratulations! Your collaborator tier was upgraded to VIP.",
      timestamp: Date.now() - 86400000,
      read: false,
    },
    {
      id: "notif-003",
      type: "dispute_update",
      title: "⚖️ Dispute Resolved",
      body: "The royalty dispute on contract CBKT...1022 has been resolved in your favor.",
      timestamp: Date.now() - 172800000,
      read: true,
    },
  ];

  private listeners: Set<(notifications: MobileNotification[]) => void> = new Set();

  /**
   * Request push notification permission from OS and get device token.
   */
  async registerForPushNotifications(): Promise<string> {
    // In React Native runtime, requests permission via @react-native-firebase/messaging or expo-notifications
    return "DEVICE_PUSH_TOKEN_SIMULATED_84820";
  }

  /**
   * Receive and process an incoming notification payload.
   */
  receiveNotification(payload: Omit<MobileNotification, "id" | "timestamp" | "read">): MobileNotification {
    const newNotif: MobileNotification = {
      ...payload,
      id: `notif_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now(),
      read: false,
    };

    this.notifications.unshift(newNotif);
    this.notify();
    return newNotif;
  }

  getNotifications(): MobileNotification[] {
    return [...this.notifications];
  }

  getUnreadCount(): number {
    return this.notifications.filter((n) => !n.read).length;
  }

  markAsRead(id: string): void {
    const notif = this.notifications.find((n) => n.id === id);
    if (notif) {
      notif.read = true;
      this.notify();
    }
  }

  markAllAsRead(): void {
    this.notifications.forEach((n) => (n.read = true));
    this.notify();
  }

  clearAll(): void {
    this.notifications = [];
    this.notify();
  }

  subscribe(callback: (notifications: MobileNotification[]) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify() {
    this.listeners.forEach((cb) => cb([...this.notifications]));
  }
}

export const pushNotificationService = new PushNotificationService();
