import { useEffect, useRef } from "react";
import "./NotificationPanel.css";

interface Notification {
  id: number;
  walletAddress: string;
  type: string;
  title: string;
  message: string | null;
  data: string | null;
  read: number;
  created_at: string;
}

interface NotificationPanelProps {
  notifications: Notification[];
  unreadCount: number;
  walletAddress: string | null;
  onClose: () => void;
  onMarkAllRead: () => void;
  onMarkRead: (id: number) => void;
  onDelete: (id: number) => void;
  onNotificationAdded?: () => void;
}

export function NotificationPanel({
  notifications,
  unreadCount,
  onClose,
  onMarkAllRead,
  onMarkRead,
  onDelete,
}: NotificationPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "distribution_confirmed": return "✅";
      case "payment_received": return "💰";
      case "payment_failed": return "❌";
      case "hold_placed": return "⏸️";
      case "hold_released": return "▶️";
      case "system": return "ℹ️";
      default: return "🔔";
    }
  };

  const timeAgo = (dateStr: string) => {
    const now = Date.now();
    const date = new Date(dateStr).getTime();
    const diff = now - date;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  return (
    <div className="notification-panel" ref={panelRef}>
      <div className="notification-panel-header">
        <h3>Notifications</h3>
        <div className="notification-panel-actions">
          {unreadCount > 0 && (
            <button className="mark-all-read-btn" onClick={onMarkAllRead}>
              Mark all read
            </button>
          )}
          <button className="notification-panel-close" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <div className="notification-panel-body">
        {notifications.length === 0 ? (
          <div className="notification-empty">No notifications yet</div>
        ) : (
          notifications.map((n) => (
            <div
              key={n.id}
              className={`notification-item ${n.read ? "read" : "unread"}`}
              onClick={() => !n.read && onMarkRead(n.id)}
            >
              <div className="notification-item-icon">
                {getTypeIcon(n.type)}
              </div>
              <div className="notification-item-content">
                <div className="notification-item-title">{n.title}</div>
                {n.message && (
                  <div className="notification-item-message">{n.message}</div>
                )}
                <div className="notification-item-time">{timeAgo(n.created_at)}</div>
              </div>
              <button
                className="notification-item-delete"
                onClick={(e) => { e.stopPropagation(); onDelete(n.id); }}
                aria-label="Delete notification"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
