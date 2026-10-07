import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from "react";
import { toast, ToastOptions } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

export type NotificationType =
  | "pending"
  | "confirmed"
  | "failed"
  | "info"
  | "distribution"
  | "distribution_confirmed"
  | "distribution_completed"
  | "payment"
  | "payment_received"
  | "payment_failed"
  | "dispute"
  | "dispute_created"
  | "dispute_resolved"
  | "reputation_changed"
  | "governance_proposal"
  | "security_alert"
  | "system"
  | "warning";

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  timestamp: number;
  txHash?: string;
  transactionId?: string | number;
  read: boolean;
  archived?: boolean;
  channel?: string;
  data?: Record<string, unknown>;
}

export interface NotificationPreferences {
  channels: {
    email: boolean;
    in_app: boolean;
    sms: boolean;
    push: boolean;
  };
  typeToggles: {
    distribution: boolean;
    payment: boolean;
    failure: boolean;
    hold: boolean;
    dispute_created: boolean;
    dispute_resolved: boolean;
    reputation_changed: boolean;
    governance: boolean;
    security_alert: boolean;
  };
  frequency: "immediate" | "daily_digest" | "weekly_digest";
  quietHours: {
    enabled: boolean;
    start: number;
    end: number;
  };
  channelPreferences: Record<string, Record<string, boolean>>;
}

interface NotificationContextType {
  notifications: Notification[];
  archivedNotifications: Notification[];
  addNotification: (
    notification: Omit<Notification, "id" | "timestamp" | "read">,
  ) => void;
  markAsRead: (id: string) => void;
  markAsUnread: (id: string) => void;
  markAllAsRead: () => void;
  archiveNotification: (id: string) => void;
  unarchiveNotification: (id: string) => void;
  clearNotification: (id: string) => void;
  clearAllNotifications: () => void;
  searchNotifications: (query: string) => Notification[];
  unreadCount: number;
  preferences: NotificationPreferences | null;
  setPreferences: (prefs: NotificationPreferences) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(
  undefined,
);

const STORAGE_KEY = "srs_notification_history";
const ARCHIVED_STORAGE_KEY = "srs_notification_archived";
const PREFS_STORAGE_KEY = "srs_notification_prefs";
const MAX_HISTORY = 50;

function loadHistory(): Notification[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // ignore
  }
  return [];
}

function loadArchived(): Notification[] {
  try {
    const stored = localStorage.getItem(ARCHIVED_STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // ignore
  }
  return [];
}

function loadPreferences(): NotificationPreferences | null {
  try {
    const stored = localStorage.getItem(PREFS_STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // ignore
  }
  return null;
}

function saveHistory(notifications: Notification[]) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(notifications.slice(-MAX_HISTORY)),
    );
  } catch {
    // ignore
  }
}

function saveArchived(notifications: Notification[]) {
  try {
    localStorage.setItem(
      ARCHIVED_STORAGE_KEY,
      JSON.stringify(notifications.slice(-MAX_HISTORY)),
    );
  } catch {
    // ignore
  }
}

function savePreferences(prefs: NotificationPreferences | null) {
  try {
    if (prefs) {
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } else {
      localStorage.removeItem(PREFS_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

const defaultToastOptions: ToastOptions = {
  position: "top-right",
  autoClose: 5000,
  hideProgressBar: false,
  closeOnClick: true,
  pauseOnHover: true,
  draggable: true,
  progress: undefined,
  theme: "light",
};

function getDefaultPreferences(): NotificationPreferences {
  return {
    channels: { email: true, in_app: true, sms: false, push: false },
    typeToggles: {
      distribution: true,
      payment: true,
      failure: true,
      hold: true,
      dispute_created: true,
      dispute_resolved: true,
      reputation_changed: false,
      governance: true,
      security_alert: true,
    },
    frequency: "immediate",
    quietHours: { enabled: false, start: 21, end: 9 },
    channelPreferences: {},
  };
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>(() =>
    loadHistory(),
  );
  const [archivedNotifications, setArchivedNotifications] = useState<Notification[]>(
    () => loadArchived(),
  );
  const [preferences, setPreferencesState] = useState<NotificationPreferences | null>(
    () => loadPreferences(),
  );

  useEffect(() => {
    saveHistory(notifications);
  }, [notifications]);

  useEffect(() => {
    saveArchived(archivedNotifications);
  }, [archivedNotifications]);

  useEffect(() => {
    savePreferences(preferences);
  }, [preferences]);

  const addNotification = useCallback(
    (notification: Omit<Notification, "id" | "timestamp" | "read">) => {
      const prefs = preferences ?? getDefaultPreferences();

      const isEnabled = getPrefValue(prefs, notification.type);
      if (!isEnabled) return;

      if (prefs.quietHours.enabled) {
        const now = new Date();
        const hour = now.getHours();
        const { start, end } = prefs.quietHours;
        if (start <= end) {
          if (hour >= start && hour < end) return;
        } else {
          if (hour >= start || hour < end) return;
        }
      }

      if (prefs.frequency === "daily_digest" || prefs.frequency === "weekly_digest") {
        const existing = notifications.find(
          (n) => n.type === notification.type && n.title === notification.title,
        );
        if (existing) return;
      }

      const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const newNotification: Notification = {
        ...notification,
        id,
        timestamp: Date.now(),
        read: false,
        archived: false,
      };

      setNotifications((prev) =>
        [newNotification, ...prev].slice(0, MAX_HISTORY),
      );

      if (prefs.channels.in_app) {
        const toastOptions: ToastOptions = {
          ...defaultToastOptions,
          onClose: () => {
            setNotifications((prev) =>
              prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
            );
          },
        };

        switch (notification.type) {
          case "pending":
            toast.info(
              `⏳ ${notification.title}: ${notification.message}`,
              toastOptions,
            );
            break;
          case "confirmed":
            toast.success(
              `✅ ${notification.title}: ${notification.message}`,
              toastOptions,
            );
            break;
          case "failed":
          case "payment_failed":
          case "dispute_created":
          case "security_alert":
            toast.error(
              `❌ ${notification.title}: ${notification.message}`,
              toastOptions,
            );
            break;
          default:
            toast(notification.message, { ...toastOptions, type: "default" });
        }
      }
    },
    [notifications, preferences],
  );

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  }, []);

  const markAsUnread = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: false } : n)),
    );
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const archiveNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    setArchivedNotifications((prev) => {
      const notification = notifications.find((n) => n.id === id);
      return notification
        ? [{ ...notification, archived: true }, ...prev].slice(0, MAX_HISTORY)
        : prev;
    });
  }, [notifications]);

  const unarchiveNotification = useCallback((id: string) => {
    setArchivedNotifications((prev) => prev.filter((n) => n.id !== id));
    setNotifications((prev) => {
      const notification = archivedNotifications.find((n) => n.id === id);
      return notification
        ? [{ ...notification, archived: false }, ...prev].slice(0, MAX_HISTORY)
        : prev;
    });
  }, [archivedNotifications]);

  const clearNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearAllNotifications = useCallback(() => {
    setNotifications((prev) =>
      prev.filter((notification) => !notification.read),
    );
  }, []);

  const searchNotifications = useCallback(
    (query: string): Notification[] => {
      const lower = query.toLowerCase();
      return notifications.filter(
        (n) =>
          n.title.toLowerCase().includes(lower) ||
          n.message.toLowerCase().includes(lower) ||
          n.type.toLowerCase().includes(lower),
      );
    },
    [notifications],
  );

  const setPreferences = useCallback((prefs: NotificationPreferences) => {
    setPreferencesState(prefs);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        archivedNotifications,
        addNotification,
        markAsRead,
        markAsUnread,
        markAllAsRead,
        archiveNotification,
        unarchiveNotification,
        clearNotification,
        clearAllNotifications,
        searchNotifications,
        unreadCount,
        preferences,
        setPreferences,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

function getPrefValue(
  prefs: NotificationPreferences,
  type: NotificationType,
): boolean {
  const typeToToggle: Record<string, keyof NotificationPreferences["typeToggles"]> = {
    distribution: "distribution",
    distribution_confirmed: "distribution",
    distribution_completed: "distribution",
    payment: "payment",
    payment_received: "payment",
    payment_failed: "payment",
    dispute: "dispute_created",
    dispute_created: "dispute_created",
    dispute_resolved: "dispute_resolved",
    reputation_changed: "reputation_changed",
    governance_proposal: "governance",
    security_alert: "security_alert",
  };

  const toggleKey = typeToToggle[type as string];
  return toggleKey ? prefs.typeToggles[toggleKey] : true;
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error(
      "useNotifications must be used within a NotificationProvider",
    );
  }
  return context;
}
