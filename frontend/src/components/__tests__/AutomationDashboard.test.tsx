import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { AutomationDashboard } from "../AutomationDashboard";

describe("AutomationDashboard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads schedules and workflows and toggles a schedule", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/v1/automation/schedules") {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: [{ id: "sch-1", name: "Weekly payout", type: "weekly", enabled: true, nextRunAt: "2026-09-28T09:00:00.000Z" }],
          }),
        } as Response;
      }

      if (url === "/api/v1/automation/workflows") {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: [{ id: "wf-1", name: "Threshold trigger", enabled: true, trigger: { type: "earningsThreshold", threshold: 250 }, actions: [{ type: "distribution" }] }],
          }),
        } as Response;
      }

      if (url.endsWith("/disable") || url.endsWith("/enable")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: { id: "sch-1", name: "Weekly payout", type: "weekly", enabled: false, nextRunAt: "2026-09-28T09:00:00.000Z" },
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ success: true, data: [] }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<AutomationDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Automation Dashboard")).toBeInTheDocument();
    });

    expect(screen.getByText("Weekly payout")).toBeInTheDocument();
    expect(screen.getByText("Threshold trigger")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disable" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/automation/schedules/sch-1/disable",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
  });
});
