import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, beforeEach, test, expect, vi } from "vitest";
import InitializeForm from "../InitializeForm";
import { api } from "../../api";

vi.mock("../../api");
vi.mock("../../stellar", () => ({
  signAndSubmitTransaction: vi.fn(),
}));
vi.mock("../../context/NetworkContext", () => ({
  useNetwork: () => ({ network: "testnet" }),
}));

const mockApi = api as any;
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";

const defaultProps = {
  contractId: CONTRACT,
  walletAddress: WALLET,
  onSuccess: vi.fn(),
};

describe("InitializeForm — accessibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listTemplates.mockResolvedValue({ data: [] });
  });

  test("every address input has an associated visible label", () => {
    render(<InitializeForm {...defaultProps} />);
    const label = screen.getByLabelText(/Collaborator 1 wallet address/i);
    expect(label).toBeDefined();
  });

  test("every percentage input has an associated visible label", () => {
    render(<InitializeForm {...defaultProps} />);
    const label = screen.getByLabelText(/Collaborator 1 percentage/i);
    expect(label).toBeDefined();
  });

  test("address error span is linked via aria-describedby", async () => {
    render(<InitializeForm {...defaultProps} />);
    const addressInput = screen.getByLabelText(
      /Collaborator 1 wallet address/i,
    );

    fireEvent.blur(addressInput);
    fireEvent.change(addressInput, {
      target: { value: "not-a-stellar-address" },
    });
    fireEvent.blur(addressInput);

    await waitFor(() => {
      const errorSpan = document.getElementById("collaborator-0-address-error");
      expect(errorSpan).toBeTruthy();
      expect(addressInput.getAttribute("aria-describedby")).toBe(
        "collaborator-0-address-error",
      );
    });
  });

  test("address input carries aria-invalid=true when field is invalid", async () => {
    render(<InitializeForm {...defaultProps} />);
    const addressInput = screen.getByLabelText(
      /Collaborator 1 wallet address/i,
    );

    fireEvent.change(addressInput, { target: { value: "BAD" } });
    fireEvent.blur(addressInput);

    await waitFor(() => {
      expect(addressInput.getAttribute("aria-invalid")).toBe("true");
    });
  });

  test("percentage error span has id matching aria-describedby on percentage input", async () => {
    render(<InitializeForm {...defaultProps} />);
    const pctInput = screen.getByLabelText(/Collaborator 1 percentage/i);

    fireEvent.change(pctInput, { target: { value: "" } });
    fireEvent.blur(pctInput);

    await waitFor(() => {
      const errorSpan = document.getElementById(
        "collaborator-0-percentage-error",
      );
      expect(errorSpan).toBeTruthy();
      expect(pctInput.getAttribute("aria-describedby")).toBe(
        "collaborator-0-percentage-error",
      );
    });
  });

  test("error messages use role=alert for immediate SR announcement", async () => {
    render(<InitializeForm {...defaultProps} />);
    const addressInput = screen.getByLabelText(
      /Collaborator 1 wallet address/i,
    );

    fireEvent.change(addressInput, { target: { value: "BAD" } });
    fireEvent.blur(addressInput);

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      expect(alerts.length).toBeGreaterThan(0);
    });
  });

  test("status region uses aria-live=polite for SR announcements", () => {
    render(<InitializeForm {...defaultProps} />);
    const liveRegion = document.querySelector('[aria-live="polite"]');
    expect(liveRegion).toBeTruthy();
  });

  test("remove button has an accessible aria-label naming the collaborator", async () => {
    render(<InitializeForm {...defaultProps} />);
    fireEvent.click(screen.getByLabelText(/Add collaborator/i));

    await waitFor(() => {
      const removeBtn = screen.getByLabelText(/Remove collaborator 1/i);
      expect(removeBtn).toBeDefined();
    });
  });

  test("submit button exposes aria-busy during loading", async () => {
    mockApi.initialize = vi.fn(() => new Promise(() => {}));

    render(<InitializeForm {...defaultProps} />);
    const addrInput = screen.getByLabelText(/Collaborator 1 wallet address/i);
    const pctInput = screen.getByLabelText(/Collaborator 1 percentage/i);

    fireEvent.change(addrInput, { target: { value: WALLET } });
    fireEvent.change(pctInput, { target: { value: "100" } });

    const submitBtn = screen.getByText(/Initialize contract/i);
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(submitBtn.getAttribute("aria-busy")).toBe("true");
    });
  });
});
