import { create } from "zustand";
import { devtools } from "zustand/middleware";

export interface UIState {
  isDark: boolean;
  networkMismatch: boolean;
  walletNetworkName: string | null;
  toggleTheme: () => void;
  setIsDark: (isDark: boolean) => void;
  setNetworkMismatch: (mismatch: boolean) => void;
  setWalletNetworkName: (name: string | null) => void;
}

const THEME_STORAGE_KEY = "theme";

function getSystemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function getInitialDarkState(): boolean {
  if (typeof window !== "undefined") {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved) return saved === "dark";
  }
  return getSystemPrefersDark();
}

export const useUIStore = create<UIState>()(
  devtools(
    (set) => ({
      isDark: getInitialDarkState(),
      networkMismatch: false,
      walletNetworkName: null,

      toggleTheme: () => {
        set(
          (state) => {
            const next = !state.isDark;
            if (typeof window !== "undefined") {
              localStorage.setItem(THEME_STORAGE_KEY, next ? "dark" : "light");
              document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
            }
            return { isDark: next };
          },
          false,
          "ui/toggleTheme",
        );
      },

      setIsDark: (isDark: boolean) => {
        if (typeof window !== "undefined") {
          document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
        }
        set({ isDark }, false, "ui/setIsDark");
      },

      setNetworkMismatch: (networkMismatch: boolean) => {
        set({ networkMismatch }, false, "ui/setNetworkMismatch");
      },

      setWalletNetworkName: (walletNetworkName: string | null) => {
        set({ walletNetworkName }, false, "ui/setWalletNetworkName");
      },
    }),
    { name: "UIStore" },
  ),
);
