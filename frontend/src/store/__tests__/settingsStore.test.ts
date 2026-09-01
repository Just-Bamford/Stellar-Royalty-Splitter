import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore, DEFAULTS } from "../settingsStore";

describe("settingsStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ settings: DEFAULTS });
  });

  it("initializes with default settings", () => {
    expect(useSettingsStore.getState().settings).toEqual(DEFAULTS);
  });

  it("updateSettings updates specified fields and persists to localStorage", () => {
    useSettingsStore.getState().updateSettings({
      displayCurrency: "USD",
      maxPayoutsPerTransaction: 25,
    });

    const settings = useSettingsStore.getState().settings;
    expect(settings.displayCurrency).toBe("USD");
    expect(settings.maxPayoutsPerTransaction).toBe(25);
    expect(settings.autoSaveAuditLog).toBe(true);

    const savedRaw = localStorage.getItem("royaltySplitterSettings");
    expect(savedRaw).not.toBeNull();
    const saved = JSON.parse(savedRaw!);
    expect(saved.displayCurrency).toBe("USD");
  });

  it("resetSettings reverts all settings back to default values", () => {
    useSettingsStore.getState().updateSettings({
      displayCurrency: "EUR",
      minPayoutAmount: 5.0,
    });

    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().settings).toEqual(DEFAULTS);
  });
});
