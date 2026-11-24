import { render } from "@testing-library/react";
import { describe, beforeEach, afterEach, test, expect, vi } from "vitest";
import { LiveEarningsCounter } from "./LiveEarningsCounter";

describe("LiveEarningsCounter animation cleanup", () => {
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextId: number;

  beforeEach(() => {
    rafCallbacks = new Map();
    nextId = 1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      const id = nextId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      rafCallbacks.delete(id);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("cancels the pending animation frame when unmounted mid-animation", () => {
    const { rerender, unmount } = render(
      <LiveEarningsCounter value={10} currency="USD" />,
    );

    // Increase the value to start an animation.
    rerender(<LiveEarningsCounter value={100} currency="USD" />);
    expect(window.requestAnimationFrame).toHaveBeenCalled();
    expect(rafCallbacks.size).toBe(1);

    const pendingId = [...rafCallbacks.keys()][0];
    unmount();

    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(pendingId);
    expect(rafCallbacks.size).toBe(0);
  });
});
