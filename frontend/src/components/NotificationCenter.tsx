import { useMemo, useState } from "react";
import { Notification, useNotifications } from "../context/NotificationContext";
import { formatDateTime } from "../utils/format";

type FilterType = "all" | Notification["type"];
type SortOrder = "newest" | "oldest";

const formatTime = (timestamp: number) => {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays < 7) return `${diffDays} days ago`;

  return formatDateTime(date, { dateStyle: "short" });
};

const getIcon = (type: Notification["type"]) => {
  switch (type) {
    case "pending":
      return "⏳";
    case "confirmed":
      return "✅";
    case "failed":
      return "❌";
    case "distribution":
      return "💰";
    case "payment":
      return "💳";
    case "dispute":
      return "⚠️";
    case "warning":
      return "⚠️";
    case "system":
      return "⚙️";
    default:
      return "ℹ️";
  }
};

const getNotificationGroup = (type: Notification["type"]) => {
  switch (type) {
    case "distribution":
      return "distribution";
    case "payment":
      return "payment";
    case "dispute":
      return "dispute";
    case "warning":
      return "warning";
    case "system":
      return "system";
    case "pending":
    case "confirmed":
    case "failed":
    case "info":
    default:
      return "system";
  }
};

export function NotificationCenter() {
  const {
    notifications,
    markAsRead,
    clearNotification,
    clearAllNotifications,
  } = useNotifications();

  const [filter, setFilter] = useState<FilterType>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");

  const filteredNotifications = useMemo(() => {
    const filtered =
      filter === "all"
        ? notifications
        : notifications.filter((notification) => notification.type === filter);

    return [...filtered].sort((a, b) =>
      sortOrder === "newest"
        ? b.timestamp - a.timestamp
        : a.timestamp - b.timestamp,
    );
  }, [notifications, filter, sortOrder]);

  const groupedNotifications = useMemo(() => {
    return filteredNotifications.reduce<Record<string, Notification[]>>(
      (groups, notification) => {
        const key = getNotificationGroup(notification.type);

        if (!groups[key]) {
          groups[key] = [];
        }

        groups[key].push(notification);
        return groups;
      },
      {},
    );
  }, [filteredNotifications]);

  return (
    <section className="notification-center">
      <div className="notification-center-header">
        <div>
          <h2>Notifications</h2>
          <p>{notifications.length} notifications</p>
        </div>

        <button
          type="button"
          onClick={clearAllNotifications}
          disabled={!notifications.some((notification) => notification.read)}
        >
          Clear Read
        </button>
      </div>

      <div className="notification-center-controls">
        <label>
          Type
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as FilterType)}
          >
            <option value="all">All</option>
            <option value="distribution">Distribution</option>
            <option value="payment">Payment</option>
            <option value="dispute">Dispute</option>
            <option value="system">System</option>
            <option value="warning">Warning</option>
            <option value="pending">Pending</option>
            <option value="confirmed">Confirmed</option>
            <option value="failed">Failed</option>
            <option value="info">Info</option>
          </select>
        </label>

        <label>
          Sort
          <select
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value as SortOrder)}
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
          </select>
        </label>
      </div>

      {filteredNotifications.length === 0 ? (
        <div className="notification-empty">
          <p>No notifications found.</p>
        </div>
      ) : (
        <div className="notification-center-list">
          {Object.entries(groupedNotifications).map(
            ([type, groupNotifications]) => (
              <div key={type} className="notification-group">
                <h3>{type}</h3>

                {groupNotifications.map((notification) => (
                  <article
                    key={notification.id}
                    className={`notification-center-item ${
                      notification.read ? "is-read" : "is-unread"
                    }`}
                  >
                    <div className="notification-center-icon">
                      {getIcon(notification.type)}
                    </div>

                    <div className="notification-center-content">
                      <div className="notification-center-title">
                        <strong>{notification.title}</strong>

                        {!notification.read && (
                          <span className="notification-unread-badge">
                            Unread
                          </span>
                        )}
                      </div>

                      <p>{notification.message}</p>

                      <time
                        dateTime={new Date(
                          notification.timestamp,
                        ).toISOString()}
                      >
                        {formatTime(notification.timestamp)}
                      </time>
                    </div>

                    <div className="notification-center-actions">
                      {!notification.read && (
                        <button
                          type="button"
                          onClick={() => markAsRead(notification.id)}
                        >
                          Mark as read
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => clearNotification(notification.id)}
                      >
                        Dismiss
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}
