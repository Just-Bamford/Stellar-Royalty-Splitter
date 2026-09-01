import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  RoyaltyPayoutPreview,
  calculatePayoutPreview,
  STROOPS_PER_XLM,
} from "./RoyaltyPayoutPreview";

const COLLAB_1 = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";
const COLLAB_2 = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const COLLAB_3 = "GBOW474QUGZMHVHF6YDRQKJ2JNOG27UPUCY4FU7E6UDBOKBZJJNWYPSIC";

describe("calculatePayoutPreview", () => {
  it("returns nothing when no sale amount is entered", () => {
    expect(calculatePayoutPreview([{ address: COLLAB_1, basisPoints: "100" }], "")).toEqual([]);
  });

  it("returns nothing for a negative or non-numeric amount", () => {
    expect(calculatePayoutPreview([{ address: COLLAB_1, basisPoints: "100" }], "-5")).toEqual([]);
    expect(calculatePayoutPreview([{ address: COLLAB_1, basisPoints: "100" }], "abc")).toEqual([]);
  });

  it("splits an even amount according to percentage shares", () => {
    const rows = calculatePayoutPreview(
      [
        { address: COLLAB_1, basisPoints: "60" },
        { address: COLLAB_2, basisPoints: "40" },
      ],
      "100",
    );

    expect(rows).toEqual([
      { address: COLLAB_1, basisPoints: 6000, payoutStroops: "600000000", payoutXlm: 60 },
      { address: COLLAB_2, basisPoints: 4000, payoutStroops: "400000000", payoutXlm: 40 },
    ]);
  });

  it("truncates (floors) each collaborator's share independently, matching the contract's integer division", () => {
    // 10.00001 XLM = 100,000,100 stroops split three ways at 33.33/33.33/33.34%.
    // Each collaborator's payout is floored independently, so the sum can land
    // slightly under the sale amount — the remainder isn't distributed to anyone,
    // exactly like the contract's checked_bps_amount.
    const rows = calculatePayoutPreview(
      [
        { address: COLLAB_1, basisPoints: "33.33" },
        { address: COLLAB_2, basisPoints: "33.33" },
        { address: COLLAB_3, basisPoints: "33.34" },
      ],
      "10.00001",
    );

    expect(rows[0].payoutStroops).toBe("33330033");
    expect(rows[1].payoutStroops).toBe("33330033");
    expect(rows[2].payoutStroops).toBe("33340033");

    const amountStroops = BigInt(Math.round(10.00001 * STROOPS_PER_XLM));
    const totalDistributed = rows.reduce((sum, r) => sum + BigInt(r.payoutStroops), 0n);
    expect(totalDistributed).toBeLessThan(amountStroops);
  });

  it("treats a collaborator with a blank/invalid percentage as 0 basis points", () => {
    const rows = calculatePayoutPreview([{ address: COLLAB_1, basisPoints: "" }], "100");
    expect(rows).toEqual([
      { address: COLLAB_1, basisPoints: 0, payoutStroops: "0", payoutXlm: 0 },
    ]);
  });
});

describe("RoyaltyPayoutPreview component", () => {
  it("prompts for a sale amount before showing any payouts", () => {
    render(
      <RoyaltyPayoutPreview
        collaborators={[{ address: COLLAB_1, basisPoints: "100" }]}
        isValid
      />,
    );

    expect(screen.getByText(/Enter a sample sale amount/i)).toBeInTheDocument();
  });

  it("updates payouts live as the sale amount changes", () => {
    render(
      <RoyaltyPayoutPreview
        collaborators={[{ address: COLLAB_1, basisPoints: "100" }]}
        isValid
      />,
    );

    const input = screen.getByLabelText(/Sample sale amount/i);
    fireEvent.change(input, { target: { value: "10" } });
    expect(screen.getByText("10 XLM")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "25" } });
    expect(screen.getByText("25 XLM")).toBeInTheDocument();
    expect(screen.queryByText("10 XLM")).not.toBeInTheDocument();
  });

  it("updates payouts live as collaborator percentages change", () => {
    const { rerender } = render(
      <RoyaltyPayoutPreview
        collaborators={[
          { address: COLLAB_1, basisPoints: "50" },
          { address: COLLAB_2, basisPoints: "50" },
        ]}
        isValid
      />,
    );

    fireEvent.change(screen.getByLabelText(/Sample sale amount/i), {
      target: { value: "100" },
    });
    expect(screen.getAllByText("50 XLM")).toHaveLength(2);

    rerender(
      <RoyaltyPayoutPreview
        collaborators={[
          { address: COLLAB_1, basisPoints: "80" },
          { address: COLLAB_2, basisPoints: "20" },
        ]}
        isValid
      />,
    );

    expect(screen.getByText("80 XLM")).toBeInTheDocument();
    expect(screen.getByText("20 XLM")).toBeInTheDocument();
  });

  it("shows a validation warning when allocations are invalid", () => {
    render(
      <RoyaltyPayoutPreview
        collaborators={[{ address: COLLAB_1, basisPoints: "40" }]}
        isValid={false}
        invalidReason="Percentages must sum to 100% (currently 40.00%) to see an accurate preview."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/must sum to 100%/i);
  });

  it("still computes a preview even while the allocation is invalid, since it's informational only", () => {
    render(
      <RoyaltyPayoutPreview
        collaborators={[{ address: COLLAB_1, basisPoints: "40" }]}
        isValid={false}
        invalidReason="Percentages must sum to 100%."
      />,
    );

    fireEvent.change(screen.getByLabelText(/Sample sale amount/i), {
      target: { value: "100" },
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("40 XLM")).toBeInTheDocument();
  });
});
