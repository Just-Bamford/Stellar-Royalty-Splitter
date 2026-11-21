import { render, screen, fireEvent } from "@testing-library/react";
import { describe, beforeEach, it, expect, vi } from "vitest";

vi.mock("../../context/NotificationContext", () => ({
  useNotifications: vi.fn(),
}));

import { NotificationBell } from "../NotificationBell";
import { useNotifications, Notification } from "../../context/NotificationContext";

describe("NotificationBell", () => {
  const mockMarkAsRead = vi.fn();
  const mockClearAllNotifications = vi.fn();

  const createNotifications = (count: number): Notification[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `notif-${i + 1}`,
      type: "confirmed" as const,
      title: `Notification ${i + 1}`,
      message: `Message content for item ${i + 1}`,
      timestamp: Date.now() - i * 1000,
      read: i >= 5, // first 5 are unread
    }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the notification bell with badge for unread count", () => {
    const notifications = createNotifications(5);
    vi.mocked(useNotifications).mockReturnValue({
      notifications,
      unreadCount: 5,
      markAsRead: mockMarkAsRead,
      clearAllNotifications: mockClearAllNotifications,
      archivedNotifications: [],
      markAsUnread: vi.fn(),
      archiveNotification: vi.fn(),
      unarchiveNotification: vi.fn(),
      clearNotification: vi.fn(),
      searchNotifications: vi.fn(),
      preferences: null,
      setPreferences: vi.fn(),
    } as any);

    render(<NotificationBell />);
    expect(screen.getByRole("button", { name: /Notifications, 5 unread/i })).toBeDefined();
    expect(screen.getByText("5")).toBeDefined();
  });

  it("opens dropdown on bell click and does not show 'more' link when count <= 20", () => {
    const notifications = createNotifications(10);
    vi.mocked(useNotifications).mockReturnValue({
      notifications,
      unreadCount: 5,
      markAsRead: mockMarkAsRead,
      clearAllNotifications: mockClearAllNotifications,
      archivedNotifications: [],
      markAsUnread: vi.fn(),
      archiveNotification: vi.fn(),
      unarchiveNotification: vi.fn(),
      clearNotification: vi.fn(),
      searchNotifications: vi.fn(),
      preferences: null,
      setPreferences: vi.fn(),
    } as any);

    render(<NotificationBell />);
    const bellBtn = screen.getByRole("button", { name: /Notifications/i });
    fireEvent.click(bellBtn);

    expect(screen.getByText("Notifications")).toBeDefined();
    expect(screen.queryByText(/View all \d+ notifications →/)).toBeNull();
  });

  it("shows 'View all {count} notifications →' link when notifications > 20 and limits dropdown to 20", () => {
    const notifications = createNotifications(25);
    vi.mocked(useNotifications).mockReturnValue({
      notifications,
      unreadCount: 5,
      markAsRead: mockMarkAsRead,
      clearAllNotifications: mockClearAllNotifications,
      archivedNotifications: [],
      markAsUnread: vi.fn(),
      archiveNotification: vi.fn(),
      unarchiveNotification: vi.fn(),
      clearNotification: vi.fn(),
      searchNotifications: vi.fn(),
      preferences: null,
      setPreferences: vi.fn(),
    } as any);

    render(<NotificationBell />);
    const bellBtn = screen.getByRole("button", { name: /Notifications/i });
    fireEvent.click(bellBtn);

    // Should display the first 20 notifications
    expect(screen.getByText("Notification 1")).toBeDefined();
    expect(screen.getByText("Notification 20")).toBeDefined();
    expect(screen.queryByText("Notification 21")).toBeNull();

    // Should display the "View all 25 notifications →" button
    const viewAllBtn = screen.getByRole("button", { name: "View all 25 notifications →" });
    expect(viewAllBtn).toBeDefined();
    expect(viewAllBtn.className).toBe("view-all-link");
  });

  it("opens Notification Center and closes dropdown when 'View all' link is clicked", () => {
    const notifications = createNotifications(25);
    vi.mocked(useNotifications).mockReturnValue({
      notifications,
      unreadCount: 5,
      markAsRead: mockMarkAsRead,
      clearAllNotifications: mockClearAllNotifications,
      archivedNotifications: [],
      markAsUnread: vi.fn(),
      archiveNotification: vi.fn(),
      unarchiveNotification: vi.fn(),
      clearNotification: vi.fn(),
      searchNotifications: vi.fn(),
      preferences: null,
      setPreferences: vi.fn(),
    } as any);

    render(<NotificationBell />);
    const bellBtn = screen.getByRole("button", { name: /Notifications/i });
    fireEvent.click(bellBtn);

    const viewAllBtn = screen.getByRole("button", { name: "View all 25 notifications →" });
    fireEvent.click(viewAllBtn);

    // Dropdown list should be closed
    expect(screen.queryByRole("listbox")).toBeNull();

    // Notification Center modal should be open and render all 25 notifications
    expect(screen.getByRole("button", { name: "Close notifications" })).toBeDefined();
    expect(screen.getByText("25 active, 0 archived, 5 unread")).toBeDefined();

    // Verify NotificationCenter displays items beyond index 20
    expect(screen.getByText("Notification 21")).toBeDefined();
    expect(screen.getByText("Notification 25")).toBeDefined();
  });

  it("can close the Notification Center modal with close button", () => {
    const notifications = createNotifications(25);
    vi.mocked(useNotifications).mockReturnValue({
      notifications,
      unreadCount: 5,
      markAsRead: mockMarkAsRead,
      clearAllNotifications: mockClearAllNotifications,
      archivedNotifications: [],
      markAsUnread: vi.fn(),
      archiveNotification: vi.fn(),
      unarchiveNotification: vi.fn(),
      clearNotification: vi.fn(),
      searchNotifications: vi.fn(),
      preferences: null,
      setPreferences: vi.fn(),
    } as any);

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole("button", { name: /Notifications/i }));
    fireEvent.click(screen.getByRole("button", { name: "View all 25 notifications →" }));

    const closeBtn = screen.getByRole("button", { name: "Close notifications" });
    fireEvent.click(closeBtn);

    expect(screen.queryByRole("button", { name: "Close notifications" })).toBeNull();
  });
});
