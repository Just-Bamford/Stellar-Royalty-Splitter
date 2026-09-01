import "@testing-library/jest-dom/vitest";
// jsdom does not implement IndexedDB; polyfill it so modules backed by
// IndexedDB (offline write queue, cached earnings snapshots) can be tested.
import "fake-indexeddb/auto";

// jsdom does not implement ResizeObserver, which recharts' ResponsiveContainer
// relies on to size the chart. Stub it so component tests can render charts
// without a real layout engine.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom's localStorage can be partial or unavailable depending on the
// environment origin; provide a functional in-memory implementation so
// components and tests that persist state (e.g. collaborator names) work.
class LocalStorageStub {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  get length() {
    return this.store.size;
  }
}

if (
  typeof globalThis.localStorage === "undefined" ||
  typeof globalThis.localStorage.clear !== "function"
) {
  const stub = new LocalStorageStub();
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: stub,
    writable: true,
    configurable: true,
  });
}

import { vi } from "vitest";
import enTranslations from "../i18n/locales/en.json";

(globalThis as typeof globalThis & { jest: typeof vi }).jest = vi;

vi.mock("react-i18next", () => {
  const translate = (key: string, options?: any) => {
    const parts = key.split(".");
    let current: any = enTranslations;
    for (const part of parts) {
      if (current && typeof current === "object" && part in current) {
        current = current[part];
      } else {
        return key;
      }
    }
    if (typeof current === "string" && options) {
      // Basic interpolation support for tests (e.g. {{network}} -> value)
      let result = current;
      Object.keys(options).forEach((optKey) => {
        result = result.replace(new RegExp(`\\{\\{\\s*${optKey}\\s*\\}\\}`, "g"), options[optKey]);
      });
      return result;
    }
    return typeof current === "string" ? current : key;
  };

  return {
    useTranslation: () => ({
      t: translate,
      i18n: {
        changeLanguage: () => Promise.resolve(),
        language: "en",
      },
    }),
  };
});

vi.mock("../context/NotificationContext", () => ({
  useNotifications: () => ({
    notifications: [],
    unreadCount: 0,
    addNotification: vi.fn(),
    markAllRead: vi.fn(),
    clearAll: vi.fn(),
    markRead: vi.fn(),
    deleteNotification: vi.fn(),
  }),
  NotificationProvider: ({ children }: any) => children,
}));

vi.mock("../hooks/queries/useHealth", () => ({
  useHealth: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    dataUpdatedAt: 0,
    refetch: vi.fn(),
  })),
  useHealthHistory: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  })),
  useHealthSla: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  })),
}));

vi.mock("../hooks/queries/useContractPerformance", () => ({
  useContractPerformance: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  })),
}));
