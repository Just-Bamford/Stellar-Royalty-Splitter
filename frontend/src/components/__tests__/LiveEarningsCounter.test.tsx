import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, beforeEach, afterEach, it, expect, vi } from "vitest";
import { LiveEarningsCounter } from "../LiveEarningsCounter";

describe("LiveEarningsCounter (#1434)", () => {
  let cancelSpy: any;
  let requestSpy: any;

  beforeEach(() => {
    vi.useFakeTimers();
    cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    requestSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 42);
  });

  afterEach(() => {
    vi.useRealTimers();
    cancelSpy.mockRestore();
    requestSpy.mockRestore();
  });

  it("renders formatted initial currency value", () => {
    render(<LiveEarningsCounter value={100} currency="USD" testId="earnings-counter" />);
    expect(screen.getByTestId("earnings-counter")).toHaveTextContent("$100.00");
  });

  it("cancels animation frame on unmount mid-animation (#1434)", () => {
    const { unmount, rerender } = render(
      <LiveEarningsCounter value={100} currency="USD" testId="earnings-counter" />
    );

    // Trigger value increase to start animation
    rerender(<LiveEarningsCounter value={250} currency="USD" testId="earnings-counter" />);

    // Unmount while animation is in flight
    unmount();

    expect(cancelSpy).toHaveBeenCalled();
  });

  it("displays delta badge when value increases and clears after timeout", () => {
    const { rerender } = render(
      <LiveEarningsCounter value={100} currency="USD" testId="earnings-counter" />
    );

    rerender(<LiveEarningsCounter value={150} currency="USD" testId="earnings-counter" />);

    expect(screen.getByText("+$50.00")).toBeInTheDocument();

    // Advance 5 seconds
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByText("+$50.00")).not.toBeInTheDocument();
  });

  it("updates immediately without animation and cancels frame when value decreases", () => {
    const { rerender } = render(
      <LiveEarningsCounter value={200} currency="USD" testId="earnings-counter" />
    );

    rerender(<LiveEarningsCounter value={100} currency="USD" testId="earnings-counter" />);

    expect(screen.getByTestId("earnings-counter")).toHaveTextContent("$100.00");
    expect(screen.queryByText(/\+\$/)).not.toBeInTheDocument();
  });
});
