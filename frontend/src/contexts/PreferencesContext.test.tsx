import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PreferencesProvider, usePreferences } from "./PreferencesContext";

function TestConsumer() {
  const { preferences, importPreferences } = usePreferences();

  return (
    <div>
      <span data-testid="theme">{preferences.theme}</span>
      <span data-testid="language">{preferences.language}</span>
      <span data-testid="units">{preferences.units}</span>
      <span data-testid="frequency">{preferences.notificationFrequency}</span>
      <span data-testid="tracking">{String(preferences.dataPrivacy.allowTracking)}</span>
      <span data-testid="partners">{String(preferences.dataPrivacy.shareDataWithPartners)}</span>

      <button onClick={() => importPreferences('{"theme":42}')}>invalid theme</button>
      <button onClick={() => importPreferences('{"theme":"dark"}')}>valid theme</button>
      <button onClick={() => importPreferences('{"unknown_key":"value"}')}>unknown key</button>
      <button
        onClick={() =>
          importPreferences(
            '{"dataPrivacy":{"allowTracking":"yes","shareDataWithPartners":1}}',
          )
        }
      >
        invalid privacy
      </button>
      <button
        onClick={() =>
          importPreferences(
            '{"dataPrivacy":{"allowTracking":false,"shareDataWithPartners":true}}',
          )
        }
      >
        valid privacy
      </button>
    </div>
  );
}

function renderPreferences() {
  return render(
    <PreferencesProvider>
      <TestConsumer />
    </PreferencesProvider>,
  );
}

describe("PreferencesContext import validation #1221", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test("does not apply a theme with the wrong type", () => {
    renderPreferences();

    fireEvent.click(screen.getByText("invalid theme"));

    expect(screen.getByTestId("theme").textContent).toBe("system");
  });

  test("applies a valid theme", () => {
    renderPreferences();

    fireEvent.click(screen.getByText("valid theme"));

    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });

  test("ignores unknown keys", () => {
    renderPreferences();

    fireEvent.click(screen.getByText("unknown key"));

    expect(screen.getByTestId("theme").textContent).toBe("system");
    expect(screen.getByTestId("language").textContent).toBe("en");
  });

  test("does not apply dataPrivacy flags with the wrong types", () => {
    renderPreferences();

    fireEvent.click(screen.getByText("invalid privacy"));

    // Tracking is opt-in, so the invalid value leaves the secure default (#1238).
    expect(screen.getByTestId("tracking").textContent).toBe("false");
    expect(screen.getByTestId("partners").textContent).toBe("false");
  });

  test("applies valid dataPrivacy flags", () => {
    renderPreferences();

    fireEvent.click(screen.getByText("valid privacy"));

    expect(screen.getByTestId("tracking").textContent).toBe("false");
    expect(screen.getByTestId("partners").textContent).toBe("true");
  });
});
