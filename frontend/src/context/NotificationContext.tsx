import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from "react";
import { toast, ToastOptions } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

export interface Notification {
  id: string;
  type: "pending" | "confirmed" | "failed" | "info";
  title: string;
  message: string;
  timestamp: number;
  txHash?: string;
  transactionId?: string | number;
  read: boolean;
}

interface NotificationContextType {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, "id" | "timestamp" | "read">) => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clearNotification: (id: string) => void;
  clearAllNotifications: () => void;
  unreadCount: number;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

const STORAGE_KEY = "srs_notification_history";
const MAX_HISTORY = 100;

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

function saveHistory(notifications: Notification[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications.slice(-MAX_HISTORY)));
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

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>(() => loadHistory());

  useEffect(() => {
    saveHistory(notifications);
  }, [notifications]);

  const addNotification = useCallback((
    notification: Omit<Notification, "id" | "timestamp" | "read">
  ) => {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newNotification: Notification = {
      ...notification,
      id,
      timestamp: Date.now(),
      read: false,
    };

    setNotifications((prev) => [newNotification, ...prev].slice(0, MAX_HISTORY));

    const toastOptions: ToastOptions = {
      ...defaultToastOptions,
      onClose: () => {
        setNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, read: true } : n))
        );
      },
    };

    switch (notification.type) {
      case "pending":
        toast.info(`⏳ ${notification.title}: ${notification.message}`, toastOptions);
        break;
      case "confirmed":
        toast.success(`✅ ${notification.title}: ${notification.message}`, toastOptions);
        break;
      case "failed":
        toast.error(`❌ ${notification.title}: ${notification.message}`, toastOptions);
        break;
      default:
        toast(notification.message, { ...toastOptions, type: "default" });
    }
  }, []);

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clearNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearAllNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        addNotification,
        markAsRead,
        markAllAsRead,
        clearNotification,
        clearAllNotifications,
        unreadCount,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error("useNotifications must be used within a NotificationProvider");
  }
  return context;
}