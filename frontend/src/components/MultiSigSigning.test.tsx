import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  MultiSigSigning,
  isProposalFullySigned,
  signersRemaining,
} from "./MultiSigSigning";

const sampleProposals = [
  {
    id: 1,
    operation: "pause_contract",
    threshold: 3,
    requiredSigners: ["admin-1", "admin-2", "admin-3"],
    approvers: ["admin-1"],
    status: "pending" as const,
  },
  {
    id: 2,
    operation: "change_admin_list",
    threshold: 2,
    requiredSigners: ["admin-1", "admin-2"],
    approvers: ["admin-1", "admin-2"],
    status: "pending" as const,
  },
];

describe("MultiSigSigning Component", () => {
  it("renders a list of pending proposals with M-of-N progress", () => {
    render(
      <MultiSigSigning
        proposals={sampleProposals}
        currentUser="admin-1"
        onSign={vi.fn()}
        onExecute={vi.fn()}
      />,
    );

    expect(screen.getAllByTestId("multisig-proposal")).toHaveLength(2);
    expect(screen.getAllByTestId("multisig-progress")[0]).toHaveTextContent("1/3 signatures");
    expect(screen.getAllByTestId("multisig-progress")[1]).toHaveTextContent("2/2 signatures");
  });

  it("lets the current user submit a signature and calls onSign", () => {
    const onSign = vi.fn();
    render(
      <MultiSigSigning
        proposals={sampleProposals}
        currentUser="admin-2"
        onSign={onSign}
        onExecute={vi.fn()}
      />,
    );

    const field = screen.getAllByTestId("multisig-signature-field")[0];
    fireEvent.change(field, { target: { value: "sig-xyz" } });
    fireEvent.click(screen.getAllByTestId("multisig-sign-btn")[0]);

    expect(onSign).toHaveBeenCalledWith(1, "sig-xyz");
  });

  it("keeps the execute button disabled until signed and threshold is met", () => {
    const onExecute = vi.fn();
    render(
      <MultiSigSigning
        proposals={[sampleProposals[0]]}
        currentUser="admin-1"
        onSign={vi.fn()}
        onExecute={onExecute}
      />,
    );

    const btn = screen.getByTestId("multisig-execute-btn");
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("enables execute once the threshold is met and the current user has signed", () => {
    const onExecute = vi.fn();
    render(
      <MultiSigSigning
        proposals={[sampleProposals[1]]}
        currentUser="admin-1"
        onSign={vi.fn()}
        onExecute={onExecute}
      />,
    );

    const btn = screen.getByTestId("multisig-execute-btn");
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onExecute).toHaveBeenCalledWith(2);
  });

  it("shows an empty state when there are no proposals", () => {
    render(
      <MultiSigSigning proposals={[]} currentUser="admin-1" onSign={vi.fn()} onExecute={vi.fn()} />,
    );
    expect(screen.getByTestId("multisig-empty")).toHaveTextContent(/no pending/i);
  });

  it("marks a proposal as already signed by the current user", () => {
    render(
      <MultiSigSigning
        proposals={[sampleProposals[1]]}
        currentUser="admin-1"
        onSign={vi.fn()}
        onExecute={vi.fn()}
      />,
    );
    expect(screen.getByTestId("multisig-already-signed")).toBeInTheDocument();
    expect(screen.queryByTestId("multisig-signature-input")).not.toBeInTheDocument();
  });
});

describe("multisig helpers", () => {
  it("isProposalFullySigned and signersRemaining compute M-of-N correctly", () => {
    const partial = { threshold: 3, approvers: ["a"] };
    expect(isProposalFullySigned(partial)).toBe(false);
    expect(signersRemaining(partial)).toBe(2);

    const complete = { threshold: 2, approvers: ["a", "b"] };
    expect(isProposalFullySigned(complete)).toBe(true);
    expect(signersRemaining(complete)).toBe(0);
  });
});
