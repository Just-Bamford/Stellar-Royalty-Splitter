import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { BulkActionToolbar } from "./BulkActionToolbar";

describe("BulkActionToolbar Component", () => {
  it("renders when items are selected and handles bulk actions", () => {
    const onSuspend = vi.fn();
    const onUnsuspend = vi.fn();
    const onChangeTier = vi.fn();
    const onSendMessage = vi.fn();
    const onClear = vi.fn();

    const { rerender } = render(
      <BulkActionToolbar
        selectedCount={0}
        totalCount={10}
        onClearSelection={onClear}
        onSuspend={onSuspend}
        onUnsuspend={onUnsuspend}
        onChangeTier={onChangeTier}
        onSendMessage={onSendMessage}
      />
    );

    expect(screen.queryByTestId("bulk-action-toolbar")).not.toBeInTheDocument();

    rerender(
      <BulkActionToolbar
        selectedCount={5}
        totalCount={10}
        onClearSelection={onClear}
        onSuspend={onSuspend}
        onUnsuspend={onUnsuspend}
        onChangeTier={onChangeTier}
        onSendMessage={onSendMessage}
      />
    );

    expect(screen.getByTestId("bulk-action-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("selected-count")).toHaveTextContent("5 collaborators selected");

    fireEvent.click(screen.getByTestId("bulk-suspend-btn"));
    expect(onSuspend).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("bulk-unsuspend-btn"));
    expect(onUnsuspend).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("bulk-tier-btn"));
    expect(screen.getByTestId("bulk-tier-form")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("apply-tier-btn"));
    expect(onChangeTier).toHaveBeenCalledWith("vip");

    fireEvent.click(screen.getByTestId("bulk-message-btn"));
    expect(screen.getByTestId("bulk-message-form")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("bulk-message-input"), {
      target: { value: "Hello collaborators" },
    });
    fireEvent.click(screen.getByTestId("send-bulk-message-btn"));
    expect(onSendMessage).toHaveBeenCalledWith("Hello collaborators");
  });
});
