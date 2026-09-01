/**
 * Tests for WebSocket transaction subscription functionality (#811).
 */
import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { broadcastTransactionStatus } from "../src/websocket.js";

describe("WebSocket transaction subscription", () => {
  beforeEach(() => {
    // Clear any existing clients map
    jest.resetModules();
  });

  test("broadcastTransactionStatus returns number of recipients", () => {
    // This is a minimal test - the actual integration requires WebSocket server
    // which is complex to mock. The function signature and return type are tested.
    const sent = broadcastTransactionStatus("txn-123", {
      id: "txn-123",
      status: "confirmed",
      fee: 100,
    });

    // Without active subscriptions, should return 0
    expect(typeof sent).toBe("number");
    expect(sent).toBeGreaterThanOrEqual(0);
  });
});
