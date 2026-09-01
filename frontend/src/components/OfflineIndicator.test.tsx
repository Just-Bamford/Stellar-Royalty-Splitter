/**
 * Tests for the offline banner: online/offline visibility (#522) plus
 * the pending-write count and manual clear action (#771).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { OfflineIndicator } from "./OfflineIndicator";
import * as offlineQueue from "../lib/offlineQueue";

describe("OfflineIndicator", () => {
  beforeEach(() => {
    vi.spyOn(offlineQueue, "getQueueCount").mockResolvedValue(0);
    vi.spyOn(offlineQueue, "subscribeToQueueUpdates").mockReturnValue(() => {});
    vi.spyOn(offlineQueue, "clearQueue").mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  test("renders nothing when online with no pending writes", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const { container } = render(<OfflineIndicator />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  test("shows the offline message when offline", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    render(<OfflineIndicator />);
    await act(async () => {});
    expect(screen.getByRole("status")).toHaveTextContent(/you're offline/i);
  });

  test("shows a syncing message with pending count while online after reconnect", async () => {
    (offlineQueue.getQueueCount as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });

    render(<OfflineIndicator />);
    await act(async () => {});

    expect(screen.getByRole("status")).toHaveTextContent(/syncing 3 pending changes/i);
  });

  test("clicking Clear queue invokes clearQueue and hides the banner", async () => {
    (offlineQueue.getQueueCount as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });

    render(<OfflineIndicator />);
    await act(async () => {});

    const clearBtn = screen.getByRole("button", { name: /clear queue/i });
    await act(async () => {
      clearBtn.click();
    });

    expect(offlineQueue.clearQueue).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("live queue updates from the service worker update the pending count", async () => {
    let capturedListener: ((count: number) => void) | null = null;
    (offlineQueue.subscribeToQueueUpdates as ReturnType<typeof vi.fn>).mockImplementation(
      (listener: (count: number) => void) => {
        capturedListener = listener;
        return () => {};
      },
    );
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });

    render(<OfflineIndicator />);
    await act(async () => {});
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    act(() => {
      capturedListener?.(1);
    });

    expect(screen.getByRole("status")).toHaveTextContent(/syncing 1 pending change\b/i);
  });
});
