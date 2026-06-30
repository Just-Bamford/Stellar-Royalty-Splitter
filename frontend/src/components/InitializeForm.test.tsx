import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import InitializeForm from "./InitializeForm";

vi.mock("../context/NetworkContext", () => ({
  useNetwork: () => ({
    network: "testnet",
    setNetwork: vi.fn(),
  }),
}));

vi.mock("../api", () => ({
  api: {
    lookupCollaborators: vi.fn().mockResolvedValue({ suggestions: [] }),
    commitInitialize: vi.fn(),
    revealInitialize: vi.fn(),
    confirmTransaction: vi.fn(),
  },
}));

const VALID_ADDRESS_1 = `G${"A".repeat(55)}`;
const VALID_ADDRESS_2 = `G${"B".repeat(55)}`;

describe("InitializeForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
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
    vi.useFakeTimers();
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    const addressInput = screen.getByPlaceholderText(/Wallet address \(G\.\.\./i);
    fireEvent.change(addressInput, { target: { value: "not-a-valid-address" } });
    fireEvent.blur(addressInput);

    expect(screen.queryByText(/Must be a valid Stellar address/i)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText(/Must be a valid Stellar address/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Commit initialization/i })).toBeDisabled();
  });

  test("shows percentage validation error for too large values", () => {
    vi.useFakeTimers();
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    const percentInput = screen.getByPlaceholderText(/% \(0–100\)/i);
    fireEvent.change(percentInput, { target: { value: "101" } });
    fireEvent.blur(percentInput);

    expect(screen.queryByText(/Percentage must be between 0 and 100/i)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText(/Percentage must be between 0 and 100/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Commit initialization/i })).toBeDisabled();
  });

  test("shows percentage validation error for fractional basis points", () => {
    vi.useFakeTimers();
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    const percentInput = screen.getByPlaceholderText(/% \(0–100\)/i);
    
    // 1. Test with 33.333 (fractional basis points)
    fireEvent.change(percentInput, { target: { value: "33.333" } });
    fireEvent.blur(percentInput);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText(/Fractional basis points are not allowed/i)).toBeInTheDocument();
    expect(percentInput).toHaveClass("input-error");

    // 2. Test with 0.005 (fractional basis points)
    fireEvent.change(percentInput, { target: { value: "0.005" } });
    fireEvent.blur(percentInput);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText(/Fractional basis points are not allowed/i)).toBeInTheDocument();

    // 3. Test with 3333.33 (too large percentage, fractional basis points if it were allowed)
    fireEvent.change(percentInput, { target: { value: "3333.33" } });
    fireEvent.blur(percentInput);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText(/Percentage must be between 0 and 100/i)).toBeInTheDocument();

    // 4. Test with -0.5 (negative decimal percentage)
    fireEvent.change(percentInput, { target: { value: "-0.5" } });
    fireEvent.blur(percentInput);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText(/Percentage must be between 0 and 100/i)).toBeInTheDocument();
  });

  test("debounces address errors until 300ms after typing stops", () => {
    vi.useFakeTimers();
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    const addressInput = screen.getByPlaceholderText(/Wallet address \(G\.\.\./i);
    fireEvent.change(addressInput, { target: { value: "bad" } });

    act(() => {
      vi.advanceTimersByTime(299);
    });

    expect(screen.queryByText(/Must be a valid Stellar address/i)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(screen.getByText(/Must be a valid Stellar address/i)).toBeInTheDocument();
  });

  test("debounces rapid percentage edits and only validates the latest value", () => {
    vi.useFakeTimers();
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    const percentInput = screen.getByLabelText(/Royalty percentage for collaborator 1/i);
    fireEvent.change(percentInput, { target: { value: "101" } });

    act(() => {
      vi.advanceTimersByTime(250);
    });

    fireEvent.change(percentInput, { target: { value: "10" } });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.queryByText(/Percentage must be between 0 and 100/i)).not.toBeInTheDocument();
    expect(percentInput).not.toHaveClass("input-error");
  });

  test("validates changed fields incrementally without touching other rows", () => {
    vi.useFakeTimers();
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Add collaborator/i }));
    const [firstAddressInput, secondAddressInput] = screen.getAllByPlaceholderText(/Wallet address \(G\.\.\./i);

    fireEvent.change(secondAddressInput, { target: { value: "bad-row-two" } });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(secondAddressInput).toHaveClass("input-error");
    expect(firstAddressInput).not.toHaveClass("input-error");
    expect(screen.getAllByText(/Must be a valid Stellar address/i)).toHaveLength(1);
  });

  test("keeps large-form typing responsive while validation waits for the debounce", () => {
    vi.useFakeTimers();
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    for (let i = 1; i < 50; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: /Add collaborator/i }));
    }

    const percentInput = screen.getByLabelText(/Royalty percentage for collaborator 50/i);
    fireEvent.change(percentInput, { target: { value: "40" } });

    expect(screen.getByTestId("share-total")).toHaveTextContent("40.00%");
    expect(screen.queryByText(/Percentage/i)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(percentInput).not.toHaveClass("input-error");
    expect(screen.getAllByPlaceholderText(/Wallet address \(G\.\.\./i)).toHaveLength(50);
  });

  test("preserves debounce delay when a validation result is cached", () => {
    vi.useFakeTimers();
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    const percentInput = screen.getByLabelText(/Royalty percentage for collaborator 1/i);
    fireEvent.change(percentInput, { target: { value: "101" } });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText(/Percentage must be between 0 and 100/i)).toBeInTheDocument();

    fireEvent.change(percentInput, { target: { value: "10" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText(/Percentage must be between 0 and 100/i)).not.toBeInTheDocument();

    fireEvent.change(percentInput, { target: { value: "101" } });
    act(() => {
      vi.advanceTimersByTime(299);
    });

    expect(screen.queryByText(/Percentage must be between 0 and 100/i)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(screen.getByText(/Percentage must be between 0 and 100/i)).toBeInTheDocument();
  });

  test("cleans up pending debounced validation when a row is removed", () => {
    vi.useFakeTimers();
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Add collaborator/i }));
    fireEvent.change(screen.getAllByPlaceholderText(/Wallet address \(G\.\.\./i)[1], {
      target: { value: "bad-row-two" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /✕/i })[0]);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.queryByText(/Must be a valid Stellar address/i)).not.toBeInTheDocument();
    expect(screen.getAllByPlaceholderText(/Wallet address \(G\.\.\./i)).toHaveLength(1);
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
