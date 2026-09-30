import { useMemo, useState } from "react";
import { Notification, useNotifications } from "../context/NotificationContext";
import "./NotificationCenter.css";

type FilterType = "all" | "unread" | "archived" | Notification["type"];
type SortOrder = "newest" | "oldest";

const ALL_FILTERS: { value: FilterType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "archived", label: "Archived" },
  { value: "distribution", label: "Distribution" },
  { value: "distribution_confirmed", label: "Distribution Confirmed" },
  { value: "distribution_completed", label: "Distribution Completed" },
  { value: "payment", label: "Payment" },
  { value: "payment_received", label: "Payment Received" },
  { value: "payment_failed", label: "Payment Failed" },
  { value: "dispute", label: "Dispute" },
  { value: "dispute_created", label: "Dispute Created" },
  { value: "dispute_resolved", label: "Dispute Resolved" },
  { value: "reputation_changed", label: "Reputation Changed" },
  { value: "governance_proposal", label: "Governance Proposal" },
  { value: "security_alert", label: "Security Alert" },
  { value: "system", label: "System" },
  { value: "warning", label: "Warning" },
];

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

  return date.toLocaleDateString();
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
    case "distribution_confirmed":
    case "distribution_completed":
      return "💰";
    case "payment":
    case "payment_received":
      return "💳";
    case "payment_failed":
      return "⚠️";
    case "dispute":
    case "dispute_created":
      return "⚠️";
    case "dispute_resolved":
      return "✅";
    case "reputation_changed":
      return "📈";
    case "governance_proposal":
      return "🗳️";
    case "security_alert":
      return "🔒";
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
    case "distribution_confirmed":
    case "distribution_completed":
      return "distribution";
    case "payment":
    case "payment_received":
    case "payment_failed":
      return "payment";
    case "dispute":
    case "dispute_created":
    case "dispute_resolved":
      return "dispute";
    case "reputation_changed":
      return "reputation";
    case "governance_proposal":
      return "governance";
    case "security_alert":
      return "security";
    case "warning":
      return "warning";
    case "system":
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
    archivedNotifications,
    markAsRead,
    markAsUnread,
    archiveNotification,
    unarchiveNotification,
    clearNotification,
    clearAllNotifications,
  } = useNotifications();

  const [filter, setFilter] = useState<FilterType>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [searchQuery, setSearchQuery] = useState("");

  const visibleNotifications = filter === "archived" ? archivedNotifications : notifications;

  const filteredNotifications = useMemo(() => {
    let filtered: Notification[];

    if (searchQuery.trim().length > 0) {
      const lower = searchQuery.toLowerCase();
      filtered = visibleNotifications.filter(
        (n) =>
          n.title.toLowerCase().includes(lower) ||
          n.message.toLowerCase().includes(lower) ||
          n.type.toLowerCase().includes(lower),
      );
    } else if (filter === "all") {
      filtered = visibleNotifications;
    } else if (filter === "unread") {
      filtered = visibleNotifications.filter((n) => !n.read);
    } else if (filter === "archived") {
      filtered = archivedNotifications;
    } else {
      filtered = visibleNotifications.filter((n) => n.type === filter);
    }

    return [...filtered].sort((a, b) =>
      sortOrder === "newest"
        ? b.timestamp - a.timestamp
        : a.timestamp - b.timestamp,
    );
  }, [visibleNotifications, archivedNotifications, filter, sortOrder, searchQuery]);

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

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (filter !== "all" && filter !== "archived") {
      setFilter("all");
    }
  };

  return (
    <section className="notification-center">
      <div className="notification-center-header">
        <div>
          <h2>Notifications</h2>
          <p>
            {notifications.length} active, {archivedNotifications.length} archived,{" "}
            {notifications.filter((n) => !n.read).length} unread
          </p>
        </div>

        <button
          type="button"
          onClick={clearAllNotifications}
          disabled={!notifications.some((notification) => notification.read)}
        >
          Clear Read
        </button>
      </div>

      <div className="notification-center-search">
        <input
          type="text"
          placeholder="Search notifications..."
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
          data-testid="notification-search-input"
        />
      </div>

      <div className="notification-center-controls">
        <label>
          Filter
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as FilterType)}
            data-testid="notification-filter-select"
          >
            {ALL_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Sort
          <select
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value as SortOrder)}
            data-testid="notification-sort-select"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
          </select>
        </label>
      </div>

      {filteredNotifications.length === 0 ? (
        <div className="notification-empty">
          <p>
            {searchQuery ? "No matching notifications found." : "No notifications found."}
          </p>
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
                    data-testid="notification-center-item"
                    data-notification-id={notification.id}
                    data-notification-type={notification.type}
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

                      {notification.data && (
                        <pre className="notification-data">
                          {JSON.stringify(notification.data, null, 2)}
                        </pre>
                      )}

                      <time
                        dateTime={new Date(
                          notification.timestamp,
                        ).toISOString()}
                      >
                        {formatTime(notification.timestamp)}
                      </time>
                    </div>

                    <div className="notification-center-actions">
                      {notification.read ? (
                        <button
                          type="button"
                          onClick={() => markAsUnread(notification.id)}
                          data-testid="notification-mark-unread"
                        >
                          Mark as unread
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => markAsRead(notification.id)}
                          data-testid="notification-mark-read"
                        >
                          Mark as read
                        </button>
                      )}

                      {!notification.archived ? (
                        <button
                          type="button"
                          onClick={() => archiveNotification(notification.id)}
                          data-testid="notification-archive"
                        >
                          Archive
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => unarchiveNotification(notification.id)}
                          data-testid="notification-unarchive"
                        >
                          Unarchive
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => clearNotification(notification.id)}
                        data-testid="notification-dismiss"
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
