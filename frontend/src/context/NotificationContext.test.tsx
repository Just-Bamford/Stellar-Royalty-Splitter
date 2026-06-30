import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  NotificationProvider,
  useNotification,
  MAX_VISIBLE_TOASTS,
  DEFAULT_TOAST_DURATION_MS,
} from "./NotificationContext";

// A harness exposing the notification API through buttons.
function Harness({ onReady }: { onReady?: (api: ReturnType<typeof useNotification>) => void }) {
  const api = useNotification();
  onReady?.(api);
  return (
    <div>
      <button onClick={() => api.success("Saved!")}>success</button>
      <button onClick={() => api.error("Boom")}>error</button>
      <button onClick={() => api.warning("Careful")}>warning</button>
      <button onClick={() => api.info("FYI")}>info</button>
    </div>
  );
}

function renderHarness(onReady?: (api: ReturnType<typeof useNotification>) => void) {
  return render(
    <NotificationProvider>
      <Harness onReady={onReady} />
    </NotificationProvider>,
  );
}

describe("NotificationContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("renders the four toast types with distinct classes", () => {
    renderHarness();
    for (const t of ["success", "error", "warning", "info"]) {
      act(() => {
        fireEvent.click(screen.getByText(t));
      });
    }
    const toasts = screen.getAllByTestId("toast");
    // Only MAX_VISIBLE_TOASTS are shown at once.
    expect(toasts.length).toBe(MAX_VISIBLE_TOASTS);
    expect(document.querySelector(".toast--success")).toBeTruthy();
    expect(document.querySelector(".toast--error")).toBeTruthy();
    expect(document.querySelector(".toast--warning")).toBeTruthy();
  });

  test("auto-dismisses after the configured duration", () => {
    let api!: ReturnType<typeof useNotification>;
    renderHarness((a) => (api = a));

    act(() => {
      api.notify({ type: "info", message: "temp", duration: 3000 });
    });
    expect(screen.getAllByTestId("toast")).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  test("caps visible toasts at 3 and promotes a queued one on dismiss", () => {
    let api!: ReturnType<typeof useNotification>;
    renderHarness((a) => (api = a));

    act(() => {
      api.info("one", { duration: 0 });
      api.info("two", { duration: 0 });
      api.info("three", { duration: 0 });
      api.info("four", { duration: 0 }); // queued
    });
    expect(screen.getAllByTestId("toast")).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(screen.queryByText("four")).toBeNull();

    // Dismiss the first → the queued "four" is promoted.
    act(() => {
      fireEvent.click(screen.getAllByLabelText("Dismiss notification")[0]);
    });
    expect(screen.getByText("four")).toBeInTheDocument();
  });

  test("Retry action runs the callback and dismisses the toast", () => {
    let api!: ReturnType<typeof useNotification>;
    const onRetry = vi.fn();
    renderHarness((a) => (api = a));

    act(() => {
      api.error("failed", { duration: 0, onRetry });
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  test("Copy action writes the provided text to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    (navigator as any).clipboard = { writeText };
    let api!: ReturnType<typeof useNotification>;
    renderHarness((a) => (api = a));

    act(() => {
      api.success("Hash ready", { duration: 0, copyText: "LONG_TX_HASH_".repeat(10) });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(writeText).toHaveBeenCalledWith("LONG_TX_HASH_".repeat(10));
  });

  test("default duration constant is 5 seconds", () => {
    expect(DEFAULT_TOAST_DURATION_MS).toBe(5000);
  });
});
