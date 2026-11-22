import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { BulkOperationsPanel } from "../BulkOperationsPanel";

describe("BulkOperationsPanel Component (#1397)", () => {
  const onBulkExport = vi.fn();
  const onAggregatedView = vi.fn();

  it("renders selected contracts count and action buttons", () => {
    render(
      <BulkOperationsPanel
        selectedCount={3}
        onBulkExport={onBulkExport}
        onAggregatedView={onAggregatedView}
      />
    );

    expect(screen.getByText("3 contracts selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export earnings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /view aggregated earnings/i })).toBeInTheDocument();
    // Bulk distribute button is not rendered when onBulkDistribute is omitted (Option B)
    expect(screen.queryByRole("button", { name: /distribute/i })).not.toBeInTheDocument();
  });

  it("triggers onBulkExport and onAggregatedView handlers when clicked", () => {
    render(
      <BulkOperationsPanel
        selectedCount={2}
        onBulkExport={onBulkExport}
        onAggregatedView={onAggregatedView}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /export earnings/i }));
    expect(onBulkExport).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /view aggregated earnings/i }));
    expect(onAggregatedView).toHaveBeenCalledTimes(1);
  });

  it("renders bulk distribute button only when onBulkDistribute callback is provided", async () => {
    const onBulkDistribute = vi.fn().mockResolvedValue(undefined);
    render(
      <BulkOperationsPanel
        selectedCount={1}
        onBulkDistribute={onBulkDistribute}
        onBulkExport={onBulkExport}
        onAggregatedView={onAggregatedView}
      />
    );

    const distributeBtn = screen.getByRole("button", { name: /Distribute to 1 selected contracts/i });
    expect(distributeBtn).toBeInTheDocument();

    fireEvent.click(distributeBtn);
    expect(onBulkDistribute).toHaveBeenCalledTimes(1);
  });
});
