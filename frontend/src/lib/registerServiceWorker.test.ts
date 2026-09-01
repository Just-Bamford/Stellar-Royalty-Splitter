/**
 * Tests for service-worker registration + connectivity watcher (#522).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isOnline,
  registerServiceWorker,
  watchConnectivity,
} from "./registerServiceWorker";

describe("registerServiceWorker (#522)", () => {
  beforeEach(() => {
    // Ensure each test starts with no SW pollution from a prior test.
    delete (navigator as Navigator & { serviceWorker?: unknown }).serviceWorker;
  });

  test("returns null when the SW API is missing (e.g. jsdom default)", async () => {
    const reg = await registerServiceWorker();
    expect(reg).toBeNull();
  });

  test("calls navigator.serviceWorker.register and forwards the result", async () => {
    const fakeReg = { scope: "/" } as unknown as ServiceWorkerRegistration;
    const register = vi.fn(async () => fakeReg);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register, controller: null },
    });
    const reg = await registerServiceWorker("/service-worker.js");
    expect(register).toHaveBeenCalledWith("/service-worker.js");
    expect(reg).toBe(fakeReg);
  });

  test("swallows registration errors and returns null", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: async () => {
          throw new Error("nope");
        },
        controller: null,
      },
    });
    const reg = await registerServiceWorker();
    expect(reg).toBeNull();
  });
});

describe("watchConnectivity (#522)", () => {
  test("invokes the callback when online/offline events fire", () => {
    const calls: boolean[] = [];
    const handle = watchConnectivity((on) => calls.push(on));

    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    handle.stop();
    // After stop(), subsequent events must NOT push to calls.
    window.dispatchEvent(new Event("offline"));

    expect(calls).toEqual([false, true]);
  });

  test("isOnline defaults to navigator.onLine", () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    expect(isOnline()).toBe(false);

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    expect(isOnline()).toBe(true);
  });

  test("posts srs-drain-queue to the SW controller on online", () => {
    const postMessage = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller: { postMessage } },
    });
    const handle = watchConnectivity(() => undefined);
    window.dispatchEvent(new Event("online"));
    handle.stop();
    expect(postMessage).toHaveBeenCalledWith({ type: "srs-drain-queue" });
  });

  describe("periodic queue retry while online (#771)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test("pings the SW to drain the queue every 15s while online", () => {
      const postMessage = vi.fn();
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: { controller: { postMessage } },
      });

      const handle = watchConnectivity(() => undefined);
      window.dispatchEvent(new Event("online"));
      postMessage.mockClear(); // ignore the immediate on-reconnect drain

      vi.advanceTimersByTime(15_000);
      expect(postMessage).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(30_000);
      expect(postMessage).toHaveBeenCalledTimes(3);

      handle.stop();
    });

    test("stops pinging once offline", () => {
      const postMessage = vi.fn();
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: { controller: { postMessage } },
      });

      const handle = watchConnectivity(() => undefined);
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("offline"));
      postMessage.mockClear();

      vi.advanceTimersByTime(60_000);
      expect(postMessage).not.toHaveBeenCalled();

      handle.stop();
    });
  });
});
