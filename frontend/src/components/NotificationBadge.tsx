import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import { NotificationPanel } from "./NotificationPanel";
import "./NotificationBadge.css";

interface NotificationBadgeProps {
  walletAddress: string | null;
  wsConnected: boolean;
}

export function NotificationBadge({ walletAddress, wsConnected }: NotificationBadgeProps) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [showPanel, setShowPanel] = useState(false);
  const [notifications, setNotifications] = useState<Array<{
    id: number;
    walletAddress: string;
    type: string;
    title: string;
    message: string | null;
    data: string | null;
    read: number;
    created_at: string;
  }>>([]);

  const fetchUnreadCount = useCallback(async () => {
    if (!walletAddress) return;
    try {
      const { count } = await api.getUnreadNotificationCount(walletAddress);
      setUnreadCount(count);
    } catch { /* ignore */ }
  }, [walletAddress]);

  const fetchNotifications = useCallback(async () => {
    if (!walletAddress) return;
    try {
      const result = await api.getNotifications(walletAddress, 20, 0);
      setNotifications(result.data);
      setUnreadCount(result.unreadCount);
    } catch { /* ignore */ }
  }, [walletAddress]);

  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  useEffect(() => {
    if (showPanel) {
      fetchNotifications();
    }
  }, [showPanel, fetchNotifications]);

  const handleTogglePanel = () => {
    setShowPanel(!showPanel);
    if (!showPanel) {
      fetchNotifications();
    }
  };

  const handleMarkAllRead = async () => {
    if (!walletAddress) return;
    try {
      await api.markAllNotificationsRead(walletAddress);
      setUnreadCount(0);
      setNotifications(prev => prev.map(n => ({ ...n, read: 1 })));
    } catch { /* ignore */ }
  };

  const handleNotificationAdded = () => {
    fetchUnreadCount();
  };

  return (
    <div className="notification-badge-wrapper">
      <button
        className={`notification-badge-btn ${unreadCount > 0 ? "has-unread" : ""}`}
        onClick={handleTogglePanel}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        title="Notifications"
      >
        <span className="notification-bell">🔔</span>
        {unreadCount > 0 && (
          <span className="notification-count">{unreadCount > 99 ? "99+" : unreadCount}</span>
        )}
        <span className={`ws-indicator ${wsConnected ? "connected" : "disconnected"}`} />
      </button>
      {showPanel && (
        <NotificationPanel
          notifications={notifications}
          unreadCount={unreadCount}
          walletAddress={walletAddress}
          onClose={() => setShowPanel(false)}
          onMarkAllRead={handleMarkAllRead}
          onMarkRead={async (id) => {
            try {
              await api.markNotificationRead(id);
              setUnreadCount(prev => Math.max(0, prev - 1));
              setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: 1 } : n));
            } catch { /* ignore */ }
          }}
          onDelete={async (id) => {
            try {
              await api.deleteNotification(id);
              setNotifications(prev => prev.filter(n => n.id !== id));
            } catch { /* ignore */ }
          }}
          onNotificationAdded={handleNotificationAdded}
        />
      )}
    </div>
  );
}
