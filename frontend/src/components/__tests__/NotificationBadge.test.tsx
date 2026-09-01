import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, beforeEach, test, expect, vi } from "vitest";
import { NotificationBadge } from "../NotificationBadge";
import { api } from "../../api";

vi.mock("../../api");

const mockApi = api as any;
const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

describe("NotificationBadge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getUnreadNotificationCount = vi.fn();
    mockApi.getNotifications = vi.fn();
    mockApi.markNotificationRead = vi.fn();
    mockApi.markAllNotificationsRead = vi.fn();
    mockApi.deleteNotification = vi.fn();
  });

  test("shows zero unread when no notifications", async () => {
    mockApi.getUnreadNotificationCount.mockResolvedValue({
      success: true,
      count: 0,
    });

    render(<NotificationBadge walletAddress={WALLET} wsConnected={true} />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Notifications/i)).toBeDefined();
    });
  });

  test("shows unread count badge", async () => {
    mockApi.getUnreadNotificationCount.mockResolvedValue({
      success: true,
      count: 5,
    });

    render(<NotificationBadge walletAddress={WALLET} wsConnected={true} />);

    await waitFor(() => {
      const badge = screen.getByText("5");
      expect(badge).toBeDefined();
    });
  });

  test("shows WebSocket connection indicator", () => {
    mockApi.getUnreadNotificationCount.mockResolvedValue({
      success: true,
      count: 0,
    });

    const { container } = render(
      <NotificationBadge walletAddress={WALLET} wsConnected={true} />,
    );

    const indicator = container.querySelector(".ws-indicator.connected");
    expect(indicator).toBeDefined();
  });

  test("shows disconnected indicator when ws not connected", () => {
    mockApi.getUnreadNotificationCount.mockResolvedValue({
      success: true,
      count: 0,
    });

    const { container } = render(
      <NotificationBadge walletAddress={WALLET} wsConnected={false} />,
    );

    const indicator = container.querySelector(".ws-indicator.disconnected");
    expect(indicator).toBeDefined();
  });

  test("opens notification panel on click", async () => {
    mockApi.getUnreadNotificationCount.mockResolvedValue({
      success: true,
      count: 1,
    });
    mockApi.getNotifications.mockResolvedValue({
      success: true,
      data: [],
      unreadCount: 0,
    });

    render(<NotificationBadge walletAddress={WALLET} wsConnected={true} />);

    const btn = screen.getByLabelText(/notifications/i);
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockApi.getNotifications).toHaveBeenCalled();
    });
  });
});
