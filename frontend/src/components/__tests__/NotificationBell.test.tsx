import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { NotificationBell } from "../NotificationBell";
import * as NotificationContext from "../../context/NotificationContext";
import * as NetworkContext from "../../context/NetworkContext";

describe("NotificationBell", () => {
  const mockMarkAsRead = vi.fn();
  const mockClearAllNotifications = vi.fn();

  const mockNotifications: NotificationContext.Notification[] = [
    {
      id: "notif-1",
      type: "success",
      title: "Payout Received",
      message: "Received 50 USDC",
      timestamp: Date.now() - 5000,
      read: false,
      txHash: "a1b2c3d4e5f678901234567890abcdefa1b2c3d4e5f678901234567890abcdef",
    },
    {
      id: "notif-2",
      type: "info",
      title: "Contract Updated",
      message: "Contract settings changed",
      timestamp: Date.now() - 60000,
      read: true,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "open").mockImplementation(() => null);

    vi.spyOn(NotificationContext, "useNotifications").mockReturnValue({
      notifications: mockNotifications,
      unreadCount: 1,
      markAsRead: mockMarkAsRead,
      clearAllNotifications: mockClearAllNotifications,
      archivedNotifications: [],
      archiveNotification: vi.fn(),
      unarchiveNotification: vi.fn(),
      clearNotification: vi.fn(),
      searchNotifications: vi.fn(() => []),
      preferences: null,
      setPreferences: vi.fn(),
      markAsUnread: vi.fn(),
    });
  });

  it("opens testnet Stellar Expert explorer URL when network is testnet", () => {
    vi.spyOn(NetworkContext, "useNetwork").mockReturnValue({
      network: "testnet",
      setNetwork: vi.fn(),
      walletNetworkName: "TESTNET",
      networkMismatch: false,
      refreshWalletNetwork: vi.fn(),
    });

    render(<NotificationBell />);

    // Open dropdown
    const bellBtn = screen.getByRole("button", { name: /notifications/i });
    fireEvent.click(bellBtn);

    // Click notification with txHash
    const notifItem = screen.getByText("Payout Received");
    fireEvent.click(notifItem);

    expect(window.open).toHaveBeenCalledWith(
      "https://stellar.expert/explorer/testnet/tx/a1b2c3d4e5f678901234567890abcdefa1b2c3d4e5f678901234567890abcdef",
      "_blank",
      "noopener,noreferrer",
    );
    expect(mockMarkAsRead).toHaveBeenCalledWith("notif-1");
  });

  it("opens mainnet (public) Stellar Expert explorer URL when network is mainnet", () => {
    vi.spyOn(NetworkContext, "useNetwork").mockReturnValue({
      network: "mainnet",
      setNetwork: vi.fn(),
      walletNetworkName: "PUBLIC",
      networkMismatch: false,
      refreshWalletNetwork: vi.fn(),
    });

    render(<NotificationBell />);

    // Open dropdown
    const bellBtn = screen.getByRole("button", { name: /notifications/i });
    fireEvent.click(bellBtn);

    // Click notification with txHash
    const notifItem = screen.getByText("Payout Received");
    fireEvent.click(notifItem);

    expect(window.open).toHaveBeenCalledWith(
      "https://stellar.expert/explorer/public/tx/a1b2c3d4e5f678901234567890abcdefa1b2c3d4e5f678901234567890abcdef",
      "_blank",
      "noopener,noreferrer",
    );
    expect(mockMarkAsRead).toHaveBeenCalledWith("notif-1");
  });

  it("marks notification as read without opening window if txHash is absent", () => {
    vi.spyOn(NetworkContext, "useNetwork").mockReturnValue({
      network: "mainnet",
      setNetwork: vi.fn(),
      walletNetworkName: "PUBLIC",
      networkMismatch: false,
      refreshWalletNetwork: vi.fn(),
    });

    render(<NotificationBell />);

    const bellBtn = screen.getByRole("button", { name: /notifications/i });
    fireEvent.click(bellBtn);

    const notifItem = screen.getByText("Contract Updated");
    fireEvent.click(notifItem);

    expect(window.open).not.toHaveBeenCalled();
    expect(mockMarkAsRead).toHaveBeenCalledWith("notif-2");
  });
});
