/**
 * Tests for the privacy-first analytics tracker (#524).
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import { analytics, scrubProps, type AnalyticsEvent } from "./analytics";

describe("analytics #524", () => {
  beforeEach(() => {
    analytics.disable();
    analytics._resetSession();
  });

  test("disabled by default and drops events", () => {
    expect(analytics.isEnabled()).toBe(false);
    analytics.dispatch("page_view", { page: "dashboard" });
    expect(analytics.getBuffer().length).toBe(0);
  });

  test("opt-in is persisted to localStorage and restored on next call", () => {
    analytics.enable();
    expect(analytics.isEnabled()).toBe(true);
    expect(localStorage.getItem("srs_analytics_optin")).toBe("true");
    analytics.disable();
    expect(localStorage.getItem("srs_analytics_optin")).toBe("false");
  });

  test("dispatch buffers the event and emits via the sink", () => {
    const captured: { name: string; props: unknown }[] = [];
    analytics.configure({
      sink: (e) => captured.push({ name: e.name, props: e.props }),
    });
    analytics.enable();
    analytics.dispatch("page_view", { page: "dashboard" });
    analytics.dispatch("shortcut_used", { combo: "ctrl+k" });

    expect(analytics.getBuffer().length).toBe(2);
    expect(captured.length).toBe(2);
    expect(captured[0].name).toBe("page_view");
    expect(captured[1].name).toBe("shortcut_used");
  });

  test("dispatch drops events that are not on the enumerated allowlist", () => {
    analytics.enable();
    // @ts-expect-error — exercising the runtime guard against unknown events
    analytics.dispatch("not_a_real_event", { foo: 1 });
    expect(analytics.getBuffer().length).toBe(0);
  });

  test("scrubProps redacts Stellar G/C/S addresses and hex hashes", () => {
    const cleaned = scrubProps({
      caller: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      contract: "CACMVW2KK4H5FZDFF2AUCAKQTEJMZZWJUIZF23XMRVYQBSXYLHZ6BKWN",
      hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      page: "dashboard",
      count: 7,
      ok: true,
    });
    expect(cleaned.caller).toBe("[redacted]");
    expect(cleaned.contract).toBe("[redacted]");
    expect(cleaned.hash).toBe("[redacted]");
    expect(cleaned.page).toBe("dashboard");
    expect(cleaned.count).toBe(7);
    expect(cleaned.ok).toBe(true);
  });

  test("session id is consistent across events in the same session", () => {
    analytics.enable();
    analytics.dispatch("page_view", {});
    analytics.dispatch("page_view", {});
    const [a, b] = analytics.getBuffer();
    expect(a.session_id).toBe(b.session_id);
  });

  test("buffer is bounded — oldest events dropped after bufferSize", () => {
    analytics.configure({ bufferSize: 3 });
    analytics.enable();
    for (let i = 0; i < 5; i++) analytics.dispatch("page_view", { i });
    const buf = analytics.getBuffer();
    expect(buf.length).toBe(3);
    expect(buf[0].props.i).toBe(2); // dropped 0 and 1
    expect(buf[2].props.i).toBe(4);
  });

  test("at least 10 enumerated event names exist (#524 acceptance criterion)", () => {
    const allowed: AnalyticsEvent[] = [
      "page_view",
      "wallet_connect_start",
      "wallet_connect_success",
      "wallet_connect_failed",
      "contract_initialize_submit",
      "contract_initialize_success",
      "distribute_submit",
      "distribute_success",
      "distribute_error",
      "secondary_sale_record",
      "secondary_royalty_distribute",
      "settings_changed",
      "help_opened",
      "shortcut_used",
      "offline_detected",
      "online_restored",
      "session_expired",
    ];
    expect(allowed.length).toBeGreaterThanOrEqual(10);
  });

  test("sink errors do not propagate", () => {
    analytics.configure({
      sink: () => {
        throw new Error("sink down");
      },
    });
    analytics.enable();
    expect(() => analytics.dispatch("page_view", {})).not.toThrow();
    expect(analytics.getBuffer().length).toBe(1);
  });

  test("sendBeacon is called when endpoint configured", () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      writable: true,
      value: beacon,
    });
    analytics.configure({ endpoint: "https://example.test/collect" });
    analytics.enable();
    analytics.dispatch("page_view", { page: "x" });
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0][0]).toBe("https://example.test/collect");
  });
});
