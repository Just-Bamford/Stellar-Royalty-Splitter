/**
 * Tests for the session-expiry handler clearing the saved page (#1181).
 *
 * `App` already clears `srs_currentPage` and routes to "connect-wallet" on
 * SESSION_EXPIRED_EVENT, and the wallet-connect handler already advances
 * from "connect-wallet" back to "dashboard" once the user reconnects — this
 * pins that the full expiry -> re-login round trip never restores a stale
 * page, which is the issue's actual acceptance criterion.
 *
 * `App` pulls in ~20 feature components and several context hooks; every
 * one not relevant to this flow is stubbed so the test exercises only the
 * localStorage/currentPage behavior the issue is about.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ThemeProvider } from "./context/ThemeContext";
import { NotificationProvider } from "./context/NotificationContext";
import { SESSION_EXPIRED_EVENT } from "./api";

vi.mock("./hooks/useWebSocket", () => ({
  useWebSocket: () => ({ connected: false }),
}));
vi.mock("./hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: () => {},
}));
vi.mock("./lib/analytics", () => ({
  analytics: { dispatch: vi.fn() },
}));
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    api: {
      getHealth: vi.fn().mockResolvedValue({ ok: true }),
      getContractState: vi.fn().mockResolvedValue(null),
    },
  };
});

// Every feature component App renders is replaced with a trivial stub —
// their real implementations make their own network calls and pull in
// large dependency subtrees irrelevant to the session-expiry flow.
const stubComponent = (name: string) => () => <div data-testid={name} />;
vi.mock("./components/Navigation", () => ({ Navigation: stubComponent("navigation") }));
vi.mock("./components/HelpModal", () => ({ default: stubComponent("help-modal") }));
vi.mock("./components/OfflineIndicator", () => ({ OfflineIndicator: stubComponent("offline") }));
vi.mock("./components/NetworkMismatchBanner", () => ({
  NetworkMismatchBanner: stubComponent("network-mismatch"),
}));
vi.mock("./components/FeatureErrorBoundary", () => ({
  FeatureErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./components/MarketplaceIntegration", () => ({ default: stubComponent("marketplace") }));
vi.mock("./components/Dashboard", () => ({ Dashboard: stubComponent("dashboard-page") }));
vi.mock("./components/EarningsDashboard", () => ({
  EarningsDashboard: stubComponent("earnings-dashboard"),
}));
vi.mock("./components/AdminDashboard", () => ({ AdminDashboard: stubComponent("admin-dashboard") }));
vi.mock("./components/Settings", () => ({ Settings: stubComponent("settings") }));
vi.mock("./components/WalletConnect", () => ({
  default: ({ onConnect }: { onConnect: (address: string) => void }) => (
    <button data-testid="connect-wallet-page" onClick={() => onConnect("GRECONNECTED")}>
      connect
    </button>
  ),
}));
vi.mock("./components/InitializeForm", () => ({ default: stubComponent("initialize-form") }));
vi.mock("./components/DistributeForm", () => ({ default: stubComponent("distribute-form") }));
vi.mock("./components/BatchClaiming", () => ({ default: stubComponent("batch-claiming") }));
vi.mock("./components/TransactionHistory", () => ({
  TransactionHistory: stubComponent("transaction-history"),
}));
vi.mock("./components/SecondaryRoyaltyConfig", () => ({ default: stubComponent("secondary-config") }));
vi.mock("./components/RecordSecondarySale", () => ({ default: stubComponent("record-secondary") }));
vi.mock("./components/DistributeSecondaryRoyalties", () => ({
  default: stubComponent("distribute-secondary"),
}));
vi.mock("./components/ResaleHistory", () => ({ default: stubComponent("resale-history") }));
vi.mock("./components/Skeleton", () => ({ Skeleton: stubComponent("skeleton") }));
vi.mock("./components/CopyButton", () => ({ CopyButton: stubComponent("copy-button") }));
vi.mock("./components/OnboardingWalkthrough", () => ({
  OnboardingWalkthrough: stubComponent("onboarding"),
}));
vi.mock("./components/HealthDashboard", () => ({ HealthDashboard: stubComponent("health-dashboard") }));
vi.mock("./components/DisputeDashboard", () => ({ DisputeDashboard: stubComponent("dispute-dashboard") }));
vi.mock("./components/ImpactDashboard", () => ({ ImpactDashboard: stubComponent("impact-dashboard") }));
vi.mock("./components/EarningsForecastCalculator", () => ({
  EarningsForecastCalculator: stubComponent("earnings-forecast"),
}));
vi.mock("./components/TokenomicsSimulator", () => ({ TokenomicsSimulator: stubComponent("tokenomics") }));
vi.mock("./components/ContractTimeline", () => ({ ContractTimeline: stubComponent("contract-timeline") }));
vi.mock("./components/ContributorSuspension", () => ({
  ContributorSuspension: stubComponent("contributor-suspension"),
}));
vi.mock("./components/BulkContributorUpload", () => ({
  BulkContributorUpload: stubComponent("bulk-upload"),
}));
vi.mock("./components/ContributorTaxInfo", () => ({ ContributorTaxInfo: stubComponent("tax-info") }));
vi.mock("./components/TaxComplianceReport", () => ({
  TaxComplianceReport: stubComponent("tax-compliance"),
}));
vi.mock("./components/PaymentHoldManager", () => ({
  PaymentHoldManager: stubComponent("payment-hold"),
}));
vi.mock("./components/FeatureFlagManager", () => ({
  FeatureFlagManager: stubComponent("feature-flags"),
}));
vi.mock("./components/ContributorOnboardingChecklist", () => ({
  ContributorOnboardingChecklist: stubComponent("onboarding-checklist"),
}));
vi.mock("./components/MultiContractEarnings", () => ({
  MultiContractEarnings: stubComponent("multi-contract-earnings"),
}));
vi.mock("./components/UserProfile", () => ({ UserProfile: stubComponent("user-profile") }));
vi.mock("./components/ActivityFeed", () => ({ ActivityFeed: stubComponent("activity-feed") }));
vi.mock("./components/CommunityForum", () => ({ CommunityForum: stubComponent("community-forum") }));

const { default: App } = await import("./App");

function renderApp() {
  return render(
    <ThemeProvider>
      <NotificationProvider>
        <App />
      </NotificationProvider>
    </ThemeProvider>,
  );
}

describe("App session-expiry handling (#1181)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  test("clears srs_currentPage from localStorage when the session expires", async () => {
    localStorage.setItem("srs_currentPage", "distribute");

    renderApp();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { message: "expired" } }),
      );
    });

    expect(localStorage.getItem("srs_currentPage")).toBeNull();
  });

  test("routes to connect-wallet immediately on expiry, not back to the stale page", async () => {
    localStorage.setItem("srs_currentPage", "distribute");

    renderApp();

    await act(async () => {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: {} }));
    });

    expect(screen.getAllByTestId("connect-wallet-page").length).toBeGreaterThan(0);
  });

  test("after expiry and re-login, the app lands on dashboard, not the page visited before expiry", async () => {
    localStorage.setItem("srs_currentPage", "distribute");

    renderApp();

    await act(async () => {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: {} }));
    });

    // Re-login: WalletConnect's stub calls onConnect, simulating the user
    // reconnecting their wallet after being bounced to "connect-wallet".
    // Both the sidebar card and the main "session expired" panel render a
    // WalletConnect stub while on that page; either one reconnecting is
    // the same action from the app's point of view.
    await act(async () => {
      screen.getAllByTestId("connect-wallet-page")[0].click();
    });

    // No contractId is set in this flow, so the dashboard case falls back to
    // its own "select or initialize a contract" empty state rather than the
    // real Dashboard component. What #1181 requires is that currentPage is
    // "dashboard" (not the page visited before expiry), which this and the
    // localStorage assertion below confirm.
    expect(screen.getByText("Select or initialize a contract to get started")).toBeInTheDocument();
    expect(screen.queryByTestId("distribute-form")).not.toBeInTheDocument();
    expect(localStorage.getItem("srs_currentPage")).toBe("dashboard");
  });
});
