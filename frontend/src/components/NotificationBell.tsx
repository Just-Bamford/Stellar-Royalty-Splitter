import { useState, useRef, useEffect } from "react";
import { useNotifications, Notification } from "../context/NotificationContext";
import { formatNumber } from "../utils/format";
import "./NotificationBell.css";

export function NotificationBell() {
  const { notifications, unreadCount, markAsRead, clearNotification, clearAllNotifications } =
    useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleNotificationClick = (notification: Notification) => {
    if (notification.txHash) {
      window.open(
        `https://stellar.expert/explorer/testnet/tx/${notification.txHash}`,
        "_blank",
        "noopener,noreferrer"
      );
    }
    markAsRead(notification.id);
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const getNotificationIcon = (type: Notification["type"]) => {
    switch (type) {
      case "pending":
        return "⏳";
      case "confirmed":
        return "✅";
      case "failed":
        return "❌";
      default:
        return "ℹ️";
    }
  };

  const getNotificationClass = (type: Notification["type"]) => {
    return `notification-item notification-item--${type}`;
  };

  return (
    <div className="notification-bell-wrapper" ref={dropdownRef}>
      <button
        className="notification-bell-btn"
        onClick={() => setIsOpen(!isOpen)}
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
        aria-expanded={isOpen}
        aria-haspopup="true"
        type="button"
      >
        <span className="bell-icon" aria-hidden="true">🔔</span>
        {unreadCount > 0 && (
          <span className="notification-badge" aria-label={`${unreadCount} unread notifications`}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="notification-dropdown" role="menu">
          <div className="notification-dropdown-header">
            <h3>Notifications</h3>
            {notifications.length > 0 && (
              <button
                className="clear-all-btn"
                onClick={() => {
                  clearAllNotifications();
                  setIsOpen(false);
                }}
                type="button"
              >
                Clear all
              </button>
            )}
          </div>

          {notifications.length === 0 ? (
            <div className="notification-empty">
              <p>No notifications yet</p>
            </div>
          ) : (
            <div className="notification-list" role="listbox">
              {notifications.slice(0, 20).map((notification) => (
                <div
                  key={notification.id}
                  className={getNotificationClass(notification.type)}
                  role="option"
                  onClick={() => handleNotificationClick(notification)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleNotificationClick(notification);
                    }
                  }}
                >
                  <div className="notification-content">
                    <span className="notification-icon" aria-hidden="true">
                      {getNotificationIcon(notification.type)}
                    </span>
                    <div className="notification-text">
                      <div className="notification-title">{notification.title}</div>
                      <div className="notification-message">{notification.message}</div>
                      <div className="notification-time">{formatTime(notification.timestamp)}</div>
                    </div>
                    {!notification.read && (
                      <span className="unread-dot" aria-label="Unread" />
                    )}
                  </div>
                </div>
              ))}
              {notifications.length > 20 && (
                <div className="notification-more">
                  <p>And {notifications.length - 20} more...</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}