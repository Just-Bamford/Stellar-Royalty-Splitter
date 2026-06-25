import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import InitializeForm from "./InitializeForm";

vi.mock("../context/NetworkContext", () => ({
  useNetwork: () => ({
    network: "testnet",
    setNetwork: vi.fn(),
  }),
}));

const VALID_ADDRESS_1 = `G${"A".repeat(55)}`;
const VALID_ADDRESS_2 = `G${"B".repeat(55)}`;

describe("InitializeForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("renders a collaborator row and action buttons", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    expect(screen.getByPlaceholderText(/Wallet address \(G\.\.\./i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/% \(0–100\)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Commit initialization/i })).toBeDisabled();
  });

  test("shows address validation error for invalid Stellar addresses", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    const addressInput = screen.getByPlaceholderText(/Wallet address \(G\.\.\./i);
    fireEvent.change(addressInput, { target: { value: "not-a-valid-address" } });
    fireEvent.blur(addressInput);

    expect(screen.getByText(/Must be a valid Stellar address/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Commit initialization/i })).toBeDisabled();
  });

  test("shows percentage validation error for too large values", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    const percentInput = screen.getByPlaceholderText(/% \(0–100\)/i);
    fireEvent.change(percentInput, { target: { value: "101" } });
    fireEvent.blur(percentInput);

    expect(screen.getByText(/Percentage must be between 0 and 100/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Commit initialization/i })).toBeDisabled();
  });

  test("shows percentage validation error for unsupported decimal precision", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    const percentInput = screen.getByPlaceholderText(/% \(0–100\)/i);
    fireEvent.change(percentInput, { target: { value: "33.333" } });
    fireEvent.blur(percentInput);

    expect(screen.getByText(/up to 2 decimal places/i)).toBeInTheDocument();
    expect(percentInput).toHaveClass("input-error");
  });

  test("adds a second collaborator row when Add collaborator is clicked", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Add collaborator/i }));
    expect(screen.getAllByPlaceholderText(/Wallet address \(G\.\.\./i)).toHaveLength(2);
    expect(screen.getAllByPlaceholderText(/% \(0–100\)/i)).toHaveLength(2);
  });

  test("updates the share total in real time", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText(/% \(0–100\)/i), {
      target: { value: "33.33" },
    });

    expect(screen.getByTestId("share-total")).toHaveTextContent("33.33%");
  });

  test("shows remaining percentage to allocate", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText(/% \(0–100\)/i), {
      target: { value: "75" },
    });

    expect(screen.getByText(/Remaining/i)).toBeInTheDocument();
    expect(screen.getByText("25.00%")).toBeInTheDocument();
  });

  test("updates the progress bar with the allocated percentage", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText(/% \(0–100\)/i), {
      target: { value: "40" },
    });

    expect(screen.getByTestId("share-progress-bar")).toHaveStyle({
      width: "40%",
    });
  });

  test("warns and highlights shares when total exceeds 100%", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText(/% \(0–100\)/i), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add collaborator/i }));
    fireEvent.change(screen.getAllByPlaceholderText(/% \(0–100\)/i)[1], {
      target: { value: "0.01" },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/Shares exceed 100%/i);
    expect(screen.getAllByPlaceholderText(/% \(0–100\)/i)[0]).toHaveClass("input-error");
    expect(screen.getAllByPlaceholderText(/% \(0–100\)/i)[1]).toHaveClass("input-error");
  });

  test("split evenly distributes decimal percentages without submitting", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Add collaborator/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add collaborator/i }));
    fireEvent.click(screen.getByRole("button", { name: /Split Evenly/i }));

    expect(screen.getAllByPlaceholderText(/% \(0–100\)/i).map((input) => (input as HTMLInputElement).value)).toEqual([
      "33.34",
      "33.33",
      "33.33",
    ]);
    expect(screen.getByTestId("share-total")).toHaveTextContent("100.00%");
  });

  test("keeps submit disabled until shares equal 100%", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Wallet address \(G\.\.\./i), {
      target: { value: VALID_ADDRESS_1 },
    });
    fireEvent.change(screen.getByPlaceholderText(/% \(0–100\)/i), {
      target: { value: "99.99" },
    });

    expect(screen.getByRole("button", { name: /Commit initialization/i })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/% \(0–100\)/i), {
      target: { value: "100" },
    });

    expect(screen.getByRole("button", { name: /Commit initialization/i })).toBeEnabled();
  });

  test("split evenly preserves a 100% total for two collaborators", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Wallet address \(G\.\.\./i), {
      target: { value: VALID_ADDRESS_1 },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add collaborator/i }));
    fireEvent.change(screen.getAllByPlaceholderText(/Wallet address \(G\.\.\./i)[1], {
      target: { value: VALID_ADDRESS_2 },
    });
    fireEvent.click(screen.getByRole("button", { name: /Split Evenly/i }));

    expect(screen.getAllByPlaceholderText(/% \(0–100\)/i).map((input) => (input as HTMLInputElement).value)).toEqual([
      "50.00",
      "50.00",
    ]);
    expect(screen.getByRole("button", { name: /Commit initialization/i })).toBeEnabled();
  });
});
