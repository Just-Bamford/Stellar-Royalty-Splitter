import { create } from "zustand";
import { devtools } from "zustand/middleware";

export interface SettingsType {
  autoSaveAuditLog: boolean;
  notifyOnDistribution: boolean;
  displayCurrency: "XLM" | "USD" | "EUR";
  maxPayoutsPerTransaction: number;
  minPayoutAmount: number;
}

export interface SettingsState {
  settings: SettingsType;
  updateSettings: (patch: Partial<SettingsType>) => void;
  resetSettings: () => void;
}

export const DEFAULTS: SettingsType = {
  autoSaveAuditLog: true,
  notifyOnDistribution: true,
  displayCurrency: "XLM",
  maxPayoutsPerTransaction: 10,
  minPayoutAmount: 0.1,
};

const SETTINGS_STORAGE_KEY = "royaltySplitterSettings";

function getInitialSettings(): SettingsType {
  try {
    if (typeof window !== "undefined") {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    }
  } catch (_) {}
  return DEFAULTS;
}

export const useSettingsStore = create<SettingsState>()(
  devtools(
    (set) => ({
      settings: getInitialSettings(),

      updateSettings: (patch: Partial<SettingsType>) => {
        set(
          (state) => {
            const nextSettings = { ...state.settings, ...patch };
            try {
              if (typeof window !== "undefined") {
                const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
                const existing = raw ? JSON.parse(raw) : {};
                const merged = { ...existing, ...nextSettings };
                localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(merged));
              }
            } catch (_) {}
            return { settings: nextSettings };
          },
          false,
          "settings/updateSettings",
        );
      },

      resetSettings: () => {
        try {
          if (typeof window !== "undefined") {
            const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
            const existing = raw ? JSON.parse(raw) : {};
            const merged = { ...existing, ...DEFAULTS };
            localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(merged));
          }
        } catch (_) {}
        set({ settings: DEFAULTS }, false, "settings/resetSettings");
      },
    }),
    { name: "SettingsStore" },
  ),
);
