import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore } from "../uiStore";

describe("uiStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useUIStore.setState({
      isDark: false,
      networkMismatch: false,
      walletNetworkName: null,
    });
  });

  it("toggleTheme switches between dark and light themes and updates DOM", () => {
    expect(useUIStore.getState().isDark).toBe(false);
    useUIStore.getState().toggleTheme();
    expect(useUIStore.getState().isDark).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");

    useUIStore.getState().toggleTheme();
    expect(useUIStore.getState().isDark).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("setIsDark explicitly sets dark mode state", () => {
    useUIStore.getState().setIsDark(true);
    expect(useUIStore.getState().isDark).toBe(true);
  });

  it("setNetworkMismatch and setWalletNetworkName update network status", () => {
    useUIStore.getState().setWalletNetworkName("PUBLIC");
    useUIStore.getState().setNetworkMismatch(true);

    expect(useUIStore.getState().walletNetworkName).toBe("PUBLIC");
    expect(useUIStore.getState().networkMismatch).toBe(true);
  });
});
