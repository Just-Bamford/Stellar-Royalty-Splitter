import { render, screen, fireEvent } from "@testing-library/react";
import { describe, beforeEach, test, expect, vi } from "vitest";
import { NotificationBell } from "./NotificationBell";

const notificationsState = vi.hoisted(() => ({
  notifications: [] as Array<Record<string, unknown>>,
}));

vi.mock("../context/NotificationContext", () => ({
  useNotifications: () => ({
    notifications: notificationsState.notifications,
    unreadCount: 0,
    markAsRead: vi.fn(),
    clearAllNotifications: vi.fn(),
  }),
}));

vi.mock("../context/NetworkContext", () => ({
  useNetwork: () => ({ network: "testnet", networkMismatch: false }),
}));

vi.mock("./NotificationCenter", () => ({
  NotificationCenter: () => <div data-testid="notification-center-stub" />,
}));

function makeNotifications(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `n-${i}`,
    type: "system",
    title: `Title ${i}`,
    message: `Message ${i}`,
    timestamp: Date.now() - i * 1000,
    read: false,
  }));
}

describe("NotificationBell", () => {
  beforeEach(() => {
    notificationsState.notifications = [];
  });

  test("shows a View all link when there are more than 20 notifications", () => {
    notificationsState.notifications = makeNotifications(25);
    render(<NotificationBell />);

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));

    expect(
      screen.getByRole("button", { name: /View all 25 notifications/ }),
    ).toBeTruthy();
  });

  test("does not show the View all link for 20 or fewer notifications", () => {
    notificationsState.notifications = makeNotifications(20);
    render(<NotificationBell />);

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));

    expect(screen.queryByRole("button", { name: /View all 20 notifications/ })).toBeNull();
  });

  test("clicking the View all link opens the Notification Center", () => {
    notificationsState.notifications = makeNotifications(25);
    render(<NotificationBell />);

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /View all 25 notifications/ }),
    );

    expect(screen.getByTestId("notification-center-stub")).toBeTruthy();
    // The dropdown closes once the center is open.
    expect(document.querySelector(".notification-dropdown")).toBeNull();
  });
});
