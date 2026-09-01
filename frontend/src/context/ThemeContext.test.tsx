/**
 * Tests for dark mode theme persistence and system preference detection (#769).
 */

import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ThemeProvider, useTheme } from "./ThemeContext";

function TestConsumer() {
  const { isDark, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="is-dark">{String(isDark)}</span>
      <button onClick={toggleTheme}>toggle</button>
    </div>
  );
}

function mockMatchMedia(prefersDark: boolean) {
  const listeners: Array<(event: MediaQueryListEvent) => void> = [];
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: prefersDark,
    media: query,
    addEventListener: (_event: string, cb: (event: MediaQueryListEvent) => void) => {
      listeners.push(cb);
    },
    removeEventListener: vi.fn(),
  }));
  return {
    fireChange: (matches: boolean) => {
      listeners.forEach((cb) => cb({ matches } as MediaQueryListEvent));
    },
  };
}

describe("ThemeContext #769", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test("applies dark theme automatically when the OS prefers dark and no saved preference exists", () => {
    mockMatchMedia(true);

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("is-dark").textContent).toBe("true");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  test("defaults to light theme when the OS prefers light and no saved preference exists", () => {
    mockMatchMedia(false);

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("is-dark").textContent).toBe("false");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  test("a saved preference overrides the OS setting on load", () => {
    mockMatchMedia(true);
    localStorage.setItem("theme", "light");

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("is-dark").textContent).toBe("false");
  });

  test("manual toggle persists the choice to localStorage", () => {
    mockMatchMedia(false);

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    act(() => {
      screen.getByText("toggle").click();
    });

    expect(screen.getByTestId("is-dark").textContent).toBe("true");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  test("persists across a fresh mount (simulated reload)", () => {
    mockMatchMedia(false);

    const { unmount } = render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    act(() => {
      screen.getByText("toggle").click();
    });
    unmount();

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("is-dark").textContent).toBe("true");
  });

  test("follows a live OS preference change when the user has no explicit override", () => {
    const { fireChange } = mockMatchMedia(false);

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("is-dark").textContent).toBe("false");

    act(() => {
      fireChange(true);
    });

    expect(screen.getByTestId("is-dark").textContent).toBe("true");
  });

  test("ignores a live OS preference change once the user has manually toggled", () => {
    const { fireChange } = mockMatchMedia(false);

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    act(() => {
      screen.getByText("toggle").click();
    });
    expect(screen.getByTestId("is-dark").textContent).toBe("true");

    act(() => {
      fireChange(false);
    });

    // Explicit user choice wins over the OS signal.
    expect(screen.getByTestId("is-dark").textContent).toBe("true");
  });

  test("throws when useTheme is used outside a ThemeProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow(
      "useTheme must be used within ThemeProvider",
    );
    spy.mockRestore();
  });
});
