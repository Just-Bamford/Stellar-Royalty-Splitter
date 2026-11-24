import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, beforeEach, test, expect, vi } from "vitest";
import RecordSecondarySale from "./RecordSecondarySale";
import { api } from "../api";

vi.mock("../api", () => ({
  api: {
    recordSecondarySale: vi.fn(),
    confirmTransaction: vi.fn(),
  },
}));

vi.mock("../stellar", () => ({
  signAndSubmitTransaction: vi.fn(),
}));

vi.mock("../context/NetworkContext", () => ({
  useNetwork: () => ({ network: "testnet", networkMismatch: false }),
}));

const mockApi = api as unknown as {
  recordSecondarySale: ReturnType<typeof vi.fn>;
  confirmTransaction: ReturnType<typeof vi.fn>;
};

const CONTRACT_ID = "C" + "A".repeat(55);
const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const PREV_OWNER = "G" + "A".repeat(55);
const NEW_OWNER = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const TOKEN = "C" + "A".repeat(55);

function fillForm() {
  fireEvent.change(screen.getByPlaceholderText("NFT identifier"), {
    target: { value: "nft-42" },
  });
  const gInputs = screen.getAllByPlaceholderText("G...");
  fireEvent.change(gInputs[0], { target: { value: PREV_OWNER } });
  fireEvent.change(gInputs[1], { target: { value: NEW_OWNER } });
  fireEvent.change(screen.getByPlaceholderText("1000"), {
    target: { value: "1000" },
  });
  fireEvent.change(screen.getByPlaceholderText("C..."), {
    target: { value: TOKEN },
  });
}

describe("RecordSecondarySale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("shows a royalty preview for a valid sale price", () => {
    render(
      <RecordSecondarySale
        contractId={CONTRACT_ID}
        walletAddress={WALLET}
        royaltyRate={500}
        onSuccess={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("1000"), {
      target: { value: "1000" },
    });

    expect(screen.getByText("Royalty: 50")).toBeTruthy();
  });

  test("clears the royalty preview on failure but keeps form data", async () => {
    mockApi.recordSecondarySale.mockRejectedValue(new Error("network down"));

    render(
      <RecordSecondarySale
        contractId={CONTRACT_ID}
        walletAddress={WALLET}
        royaltyRate={500}
        onSuccess={vi.fn()}
      />,
    );

    fillForm();
    expect(screen.getByText("Royalty: 50")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Record Sale" }));

    await waitFor(() => {
      expect(screen.getByText(/Error: network down/)).toBeTruthy();
    });

    // Royalty preview is cleared after the failed submission.
    expect(screen.queryByText(/Royalty:/)).toBeNull();

    // Form data is preserved so the user can retry.
    expect(
      (screen.getByPlaceholderText("NFT identifier") as HTMLInputElement).value,
    ).toBe("nft-42");
    expect(
      (screen.getByPlaceholderText("1000") as HTMLInputElement).value,
    ).toBe("1000");
    expect(
      (screen.getByPlaceholderText("C...") as HTMLInputElement).value,
    ).toBe(TOKEN);
  });
});
