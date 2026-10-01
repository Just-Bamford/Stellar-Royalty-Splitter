/**
 * Tests for the WebhookManager component (#1059).
 *
 * Covers: registration list + stats dashboard, delivery history rendering,
 * manual test ping, and event subscription display.
 *
 * Run with: cd frontend && npx vitest run src/components/WebhookManager.test.tsx
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import "@testing-library/jest-dom";
import { WebhookManager } from "./WebhookManager";

vi.mock("../api", () => ({
  api: {
    getWebhookEvents: vi.fn(),
    listWebhooks: vi.fn(),
    registerWebhook: vi.fn(),
    deregisterWebhook: vi.fn(),
    testWebhook: vi.fn(),
    rotateWebhookSecret: vi.fn(),
    emitWebhookEvent: vi.fn(),
    getWebhookDeliveries: vi.fn(),
    getWebhookDeliveryStats: vi.fn(),
  },
}));

import { api } from "../api";

const mockGetWebhookEvents = api.getWebhookEvents as Mock;
const mockListWebhooks = api.listWebhooks as Mock;
const mockRegisterWebhook = api.registerWebhook as Mock;
const mockDeregisterWebhook = api.deregisterWebhook as Mock;
const mockTestWebhook = api.testWebhook as Mock;
const mockGetWebhookDeliveries = api.getWebhookDeliveries as Mock;
const mockGetWebhookDeliveryStats = api.getWebhookDeliveryStats as Mock;

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const mockEvents = ["distribution.completed", "dispute.created", "dispute.resolved"];

const mockWebhookList = [
  {
    id: 1,
    contractId: CONTRACT,
    url: "https://example.com/hook",
    enabled: 1,
    events: ["dispute.created"],
    hasSecret: true,
    retryCount: 0,
    nextRetryTime: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const mockStats = { total: 5, delivered: 4, failed: 1, pending: 0, exhausted: 0 };

const mockDeliveries = [
  {
    id: 10,
    webhookId: 1,
    contractId: CONTRACT,
    event: "dispute.created",
    url: "https://example.com/hook",
    payload: "{}",
    status: "delivered",
    httpStatus: 200,
    attempts: 1,
    error: null,
    durationMs: 120,
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];

function setup() {
  mockGetWebhookEvents.mockResolvedValue({ success: true, data: mockEvents });
  mockListWebhooks.mockResolvedValue({ success: true, data: mockWebhookList });
  mockGetWebhookDeliveryStats.mockResolvedValue({ success: true, data: mockStats });
  mockGetWebhookDeliveries.mockResolvedValue({
    success: true,
    data: mockDeliveries,
    pagination: { total: 1, limit: 50, offset: 0 },
  });
  render(<WebhookManager contractId={CONTRACT} />);
}

describe("WebhookManager", () => {
  beforeEach(() => vi.clearAllMocks());

  test("shows the delivery status dashboard", async () => {
    setup();

    await waitFor(() => expect(screen.getByText("Webhook Integrations")).toBeInTheDocument());
    expect(screen.getByText("Total deliveries")).toBeInTheDocument();
    expect(screen.getByText("Delivery rate")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  test("lists registered webhooks with their event subscriptions", async () => {
    setup();

    await waitFor(() => expect(screen.getByText("https://example.com/hook")).toBeInTheDocument());
    expect(screen.getAllByText("dispute.created").length).toBeGreaterThan(0);
    expect(screen.getByText("HMAC signed")).toBeInTheDocument();
  });

  test("renders the delivery history table", async () => {
    setup();

    await waitFor(() => expect(screen.getByText("Delivery history (1)")).toBeInTheDocument());
    expect(screen.getAllByText("delivered").length).toBeGreaterThan(0);
  });

  test("registers a webhook and shows the one-time secret", async () => {
    setup();
    mockRegisterWebhook.mockResolvedValue({
      success: true,
      webhookId: 2,
      url: "https://new.example.com/hook",
      secret: "s3cr3t",
    });

    await waitFor(() => expect(screen.getByLabelText("Webhook URL")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Webhook URL"), {
      target: { value: "https://new.example.com/hook" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register" }));

    await waitFor(() =>
      expect(mockRegisterWebhook).toHaveBeenCalledWith(CONTRACT, "https://new.example.com/hook", []),
    );
    expect(screen.getByText(/s3cr3t/)).toBeInTheDocument();
  });

  test("sends a manual test ping", async () => {
    setup();
    mockTestWebhook.mockResolvedValue({ success: true, deliveryId: 11 });

    await waitFor(() => expect(screen.getByText("Send test ping")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Send test ping"));

    await waitFor(() => expect(mockTestWebhook).toHaveBeenCalledWith(CONTRACT, 1));
  });

  test("removes a webhook after confirmation", async () => {
    setup();
    mockDeregisterWebhook.mockResolvedValue({ success: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await waitFor(() => expect(screen.getByText("Remove")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Remove"));

    await waitFor(() => expect(mockDeregisterWebhook).toHaveBeenCalledWith(CONTRACT, 1));
    (window.confirm as Mock).mockRestore();
  });
});
