import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { BulkOperationsPanel } from "./BulkOperationsPanel";

// #1397: the "Distribute to All" placeholder (confirm + console.log, no
// request) is removed until a multi-contract distribute endpoint exists.

describe("BulkOperationsPanel (#1397)", () => {
  it("does not render a bulk distribute action", () => {
    render(
      <BulkOperationsPanel selectedCount={3} onBulkExport={vi.fn()} onAggregatedView={vi.fn()} />
    );

    expect(screen.queryByRole("button", { name: /distribute/i })).not.toBeInTheDocument();
    expect(screen.getByText("3 contracts selected")).toBeInTheDocument();
  });

  it("keeps the export and aggregated view actions working", () => {
    const onBulkExport = vi.fn();
    const onAggregatedView = vi.fn();
    render(
      <BulkOperationsPanel
        selectedCount={1}
        onBulkExport={onBulkExport}
        onAggregatedView={onAggregatedView}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Export earnings/i }));
    fireEvent.click(screen.getByRole("button", { name: /aggregated earnings/i }));
    expect(onBulkExport).toHaveBeenCalledTimes(1);
    expect(onAggregatedView).toHaveBeenCalledTimes(1);
  });
});
