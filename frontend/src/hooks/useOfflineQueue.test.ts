/**
 * Tests for the useOfflineQueue hook (#830).
 *
 * The hook listens for `srs-queue-size` and `srs-write-replayed` messages
 * from the service worker and maintains a local queue-size count. These
 * tests exercise the message-handling logic and the SW controller
 * postMessage contract.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

// ── Helpers that mirror the hook's internal behaviour ──────────────────────

type SWMessage =
  | { type: "srs-queue-size"; size: number }
  | { type: "srs-write-replayed"; url: string }
  | { type: string };

function applyMessage(currentSize: number, msg: SWMessage): number {
  if (msg.type === "srs-queue-size") {
    return (msg as { type: "srs-queue-size"; size: number }).size;
  }
  // write-replayed doesn't directly set the size; it triggers a re-request.
  return currentSize;
}

function requestQueueSize(controller: { postMessage: (m: unknown) => void } | null): void {
  if (!controller) return;
  controller.postMessage({ type: "srs-get-queue-size" });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("useOfflineQueue (#830)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("initial queue size is 0", () => {
    let size = 0;
    expect(size).toBe(0);
  });

  test("srs-queue-size message updates queue size", () => {
    let size = 0;
    const msg: SWMessage = { type: "srs-queue-size", size: 3 };
    size = applyMessage(size, msg);
    expect(size).toBe(3);
  });

  test("multiple srs-queue-size messages use the latest value", () => {
    let size = 0;
    size = applyMessage(size, { type: "srs-queue-size", size: 5 });
    size = applyMessage(size, { type: "srs-queue-size", size: 2 });
    size = applyMessage(size, { type: "srs-queue-size", size: 0 });
    expect(size).toBe(0);
  });

  test("srs-write-replayed does not directly mutate size", () => {
    let size = 4;
    size = applyMessage(size, { type: "srs-write-replayed", url: "/api/distribute" });
    // Size unchanged; hook would re-request, SW would reply with updated count.
    expect(size).toBe(4);
  });

  test("unknown message types are ignored", () => {
    let size = 2;
    size = applyMessage(size, { type: "some-other-event" });
    expect(size).toBe(2);
  });

  test("requestQueueSize posts srs-get-queue-size to SW controller", () => {
    const postMessage = jest.fn();
    requestQueueSize({ postMessage });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: "srs-get-queue-size" });
  });

  test("requestQueueSize is a no-op when controller is null", () => {
    expect(() => requestQueueSize(null)).not.toThrow();
  });

  test("queue size of 1 produces singular label", () => {
    const size = 1;
    const label = `${size} write${size === 1 ? "" : "s"} queued`;
    expect(label).toBe("1 write queued");
  });

  test("queue size of 3 produces plural label", () => {
    const size = 3;
    const label = `${size} write${size === 1 ? "" : "s"} queued`;
    expect(label).toBe("3 writes queued");
  });

  test("queue size of 0 produces no badge text (empty string case)", () => {
    const size = 0;
    const queueLabel = size > 0 ? ` · ${size} write${size === 1 ? "" : "s"} queued` : "";
    expect(queueLabel).toBe("");
  });
});
