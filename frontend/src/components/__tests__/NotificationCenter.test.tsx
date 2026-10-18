import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, beforeEach, test, expect, vi } from "vitest";

vi.mock("../../context/NotificationContext", () => ({
  useNotifications: vi.fn(),
}));

import { NotificationCenter } from "../NotificationCenter";
import { useNotifications } from "../../context/NotificationContext";

const mockFn: any = {
  notifications: [
    {
      id: "1",
      type: "distribution_completed",
      title: "Distribution Complete",
      message: "Your distribution was processed",
      timestamp: Date.now(),
      read: false,
      archived: false,
    },
    {
      id: "2",
      type: "security_alert",
      title: "Security Alert",
      message: "Suspicious activity detected",
      timestamp: Date.now() - 60000,
      read: true,
      archived: false,
    },
  ],
  archivedNotifications: [],
  markAsRead: vi.fn(),
  markAsUnread: vi.fn(),
  archiveNotification: vi.fn(),
  unarchiveNotification: vi.fn(),
  clearNotification: vi.fn(),
  clearAllNotifications: vi.fn(),
  searchNotifications: vi.fn(() => []),
  unreadCount: 1,
  preferences: null,
  setPreferences: vi.fn(),
};

const defaultNotifications = [
  {
    id: "1",
    type: "distribution_completed",
    title: "Distribution Complete",
    message: "Your distribution was processed",
    timestamp: Date.now(),
    read: false,
    archived: false,
  },
  {
    id: "2",
    type: "security_alert",
    title: "Security Alert",
    message: "Suspicious activity detected",
    timestamp: Date.now() - 60000,
    read: true,
    archived: false,
  },
];

describe("NotificationCenter", () => {
  beforeEach(() => {
    mockFn.notifications = [...defaultNotifications];
    mockFn.archivedNotifications = [];
    mockFn.markAsRead = vi.fn();
    mockFn.markAsUnread = vi.fn();
    mockFn.archiveNotification = vi.fn();
    mockFn.unarchiveNotification = vi.fn();
    mockFn.clearNotification = vi.fn();
    mockFn.clearAllNotifications = vi.fn();
    mockFn.searchNotifications = vi.fn(() => []);
    mockFn.unreadCount = 1;
    vi.mocked(useNotifications).mockReturnValue(mockFn);
  });

  test("renders notification center with header", () => {
    render(<NotificationCenter />);
    expect(screen.getByText("Notifications")).toBeDefined();
    expect(screen.getByText(/1 unread/)).toBeDefined();
  });

  test("displays notifications grouped by type", () => {
    render(<NotificationCenter />);
    const items = screen.getAllByTestId("notification-center-item");
    expect(items).toHaveLength(2);
    expect(document.body.textContent).toContain("Distribution Complete");
    expect(document.body.textContent).toContain("Security Alert");
  });

  test("shows unread badge for unread notifications", () => {
    render(<NotificationCenter />);
    const items = screen.getAllByTestId("notification-center-item");
    expect(items[0].className).toContain("is-unread");
    expect(document.body.textContent).toContain("Unread");
  });

  test("mark as unread button appears for read notifications", async () => {
    render(<NotificationCenter />);
    const markUnreadBtn = await screen.findByTestId("notification-mark-unread");
    expect(markUnreadBtn).toBeDefined();
    fireEvent.click(markUnreadBtn);
    expect(mockFn.markAsUnread).toHaveBeenCalledWith("2");
  });

  test("mark as read button appears for unread notifications", async () => {
    render(<NotificationCenter />);
    const markReadBtn = await screen.findByTestId("notification-mark-read");
    expect(markReadBtn).toBeDefined();
    fireEvent.click(markReadBtn);
    expect(mockFn.markAsRead).toHaveBeenCalledWith("1");
  });

  test("archive button appears for non-archived notifications", async () => {
    render(<NotificationCenter />);
    const archiveBtns = screen.getAllByTestId("notification-archive");
    expect(archiveBtns).toHaveLength(2);
    fireEvent.click(archiveBtns[0]);
    expect(mockFn.archiveNotification).toHaveBeenCalledWith("1");
  });

  test("dismiss button removes notification", async () => {
    render(<NotificationCenter />);
    const dismissBtns = screen.getAllByTestId("notification-dismiss");
    expect(dismissBtns).toHaveLength(2);
    fireEvent.click(dismissBtns[0]);
    expect(mockFn.clearNotification).toHaveBeenCalledWith("1");
  });

  test("search input filters notifications", async () => {
    render(<NotificationCenter />);
    const searchInput = screen.getByTestId("notification-search-input");
    fireEvent.change(searchInput, { target: { value: "security" } });

    await waitFor(() => {
      expect(mockFn.searchNotifications).not.toHaveBeenCalled();
    });
  });

  test("empty state shown when no notifications", () => {
    mockFn.notifications = [];
    mockFn.unreadCount = 0;
    render(<NotificationCenter />);
    expect(screen.getByText("No notifications found.")).toBeDefined();
  });

  test("filter dropdown allows selecting different types", async () => {
    render(<NotificationCenter />);
    const filterSelect = screen.getByTestId("notification-filter-select");
    expect(filterSelect).toBeDefined();

    fireEvent.change(filterSelect, { target: { value: "security_alert" } });
    expect(filterSelect).toHaveValue("security_alert");
  });

  test("sort dropdown allows selecting sort order", () => {
    render(<NotificationCenter />);
    const sortSelect = screen.getByTestId("notification-sort-select");
    expect(sortSelect).toBeDefined();
    expect(sortSelect).toHaveValue("newest");
  });

  test("clear all reads button is present", () => {
    render(<NotificationCenter />);
    const clearReadBtn = screen.getByText("Clear Read");
    expect(clearReadBtn).toBeDefined();
  });
});

describe("NotificationCenter - Archived notifications", () => {
  beforeEach(() => {
    mockFn.notifications = [];
    mockFn.archivedNotifications = [
      {
        id: "3",
        type: "governance_proposal",
        title: "Governance Proposal",
        message: "New proposal submitted",
        timestamp: Date.now(),
        read: true,
        archived: true,
      },
    ];
    mockFn.unreadCount = 0;
    vi.mocked(useNotifications).mockReturnValue(mockFn);
  });

  test("shows archived notifications when archived filter selected", () => {
    render(<NotificationCenter />);
    const filterSelect = screen.getByTestId("notification-filter-select");
    fireEvent.change(filterSelect, { target: { value: "archived" } });

    expect(screen.getAllByTestId("notification-center-item")).toHaveLength(1);
    expect(document.body.textContent).toContain("Governance Proposal");
  });

  test("unarchive button appears for archived notifications", () => {
    render(<NotificationCenter />);
    const filterSelect = screen.getByTestId("notification-filter-select");
    fireEvent.change(filterSelect, { target: { value: "archived" } });

    expect(screen.getByTestId("notification-unarchive")).toBeDefined();
  });
});
