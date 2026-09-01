/**
 * Tests for InitializeForm's validation summary (issue #694).
 *
 * Run with: cd frontend && npx react-scripts test --watchAll=false --testPathPattern=InitializeForm
 */

import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi } from "vitest";

vi.mock("../api");
vi.mock("../stellar", () => ({
  signAndSubmitTransaction: vi.fn(),
}));
vi.mock("../context/NetworkContext", () => ({
  useNetwork: () => ({
    network: "testnet",
    networkMismatch: false,
  }),
}));

import InitializeForm from "./InitializeForm";

const VALID_ADDRESS_A = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

function setup() {
  render(
    <InitializeForm
      contractId="CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      walletAddress={VALID_ADDRESS_A}
      onSuccess={vi.fn()}
    />,
  );
}

describe("InitializeForm validation summary", () => {
  it("shows a ready-to-deploy state once all fields are valid and shares sum to 100%", () => {
    setup();

    fireEvent.change(screen.getByLabelText("Collaborator 1 wallet address"), {
      target: { value: VALID_ADDRESS_A },
    });
    fireEvent.change(screen.getByLabelText("Collaborator 1 percentage"), {
      target: { value: "100" },
    });

    expect(screen.getByTestId("validation-summary-status")).toHaveTextContent(
      "Ready to deploy",
    );
  });

  it("lists an issue for a missing address and an invalid percentage", () => {
    setup();

    fireEvent.change(screen.getByLabelText("Collaborator 1 percentage"), {
      target: { value: "150" },
    });

    const status = screen.getByTestId("validation-summary-status");
    expect(status).toHaveTextContent(/issue/);
    expect(screen.getByText(/wallet address is required/i)).toBeInTheDocument();
    expect(
      screen.getAllByText(/Percentage must be between 0 and 100/i).length,
    ).toBeGreaterThan(0);
  });

  it("lists a share-total issue when percentages do not sum to 100%", () => {
    setup();

    fireEvent.change(screen.getByLabelText("Collaborator 1 wallet address"), {
      target: { value: VALID_ADDRESS_A },
    });
    fireEvent.change(screen.getByLabelText("Collaborator 1 percentage"), {
      target: { value: "40" },
    });

    expect(
      screen.getByText(/Percentages must sum to 100%/i),
    ).toBeInTheDocument();
  });

  it("flags duplicate addresses across rows", () => {
    setup();
    fireEvent.click(screen.getByText("+ Add collaborator"));

    fireEvent.change(screen.getByLabelText("Collaborator 1 wallet address"), {
      target: { value: VALID_ADDRESS_A },
    });
    fireEvent.change(screen.getByLabelText("Collaborator 1 percentage"), {
      target: { value: "50" },
    });
    fireEvent.change(screen.getByLabelText("Collaborator 2 wallet address"), {
      target: { value: VALID_ADDRESS_A },
    });
    fireEvent.change(screen.getByLabelText("Collaborator 2 percentage"), {
      target: { value: "50" },
    });

    expect(screen.getByText(/duplicate address/i)).toBeInTheDocument();
  });

  it("moves focus to the offending field when an issue is clicked", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Collaborator 1 percentage"), {
      target: { value: "150" },
    });

    fireEvent.click(screen.getByText(/wallet address is required/i));

    expect(screen.getByLabelText("Collaborator 1 wallet address")).toHaveFocus();
  });

  it("updates the summary in real time as fields change", () => {
    setup();

    expect(screen.getByTestId("validation-summary-status")).toHaveTextContent(
      /issue/,
    );

    fireEvent.change(screen.getByLabelText("Collaborator 1 wallet address"), {
      target: { value: VALID_ADDRESS_A },
    });
    fireEvent.change(screen.getByLabelText("Collaborator 1 percentage"), {
      target: { value: "100" },
    });

    expect(screen.getByTestId("validation-summary-status")).toHaveTextContent(
      "Ready to deploy",
    );

    fireEvent.change(screen.getByLabelText("Collaborator 1 percentage"), {
      target: { value: "50" },
    });

    expect(screen.getByTestId("validation-summary-status")).toHaveTextContent(
      /issue/,
    );
  });

  it("gives the summary an accessible live region so assistive tech announces changes", () => {
    setup();

    const summary = screen.getByTestId("validation-summary");
    expect(summary).toHaveAttribute("aria-live", "polite");
    expect(summary).toHaveAttribute("role", "region");
  });
});
