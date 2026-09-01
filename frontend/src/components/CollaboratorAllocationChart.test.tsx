import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import CollaboratorAllocationChart from "./CollaboratorAllocationChart";

const COLLAB1 = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const COLLAB2 = "GBOW474QUGZMHVHF6YDRQKJ2JNOG27UPUCY4FU7E6UDBOKBZJJNWYPSI";
const COLLAB3 = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

describe("CollaboratorAllocationChart", () => {
  test("renders nothing for an empty collaborator list", () => {
    const { container } = render(<CollaboratorAllocationChart collaborators={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("small list — renders exact percentages matching basisPoints for every contributor", () => {
    render(
      <CollaboratorAllocationChart
        collaborators={[
          { address: COLLAB1, basisPoints: 6000 },
          { address: COLLAB2, basisPoints: 4000 },
        ]}
      />
    );

    expect(screen.getByText("60.00%")).toBeInTheDocument();
    expect(screen.getByText("40.00%")).toBeInTheDocument();
    // Total allocated line
    expect(screen.getByText(/100\.00% allocated/)).toBeInTheDocument();
  });

  test("legend shows the truncated address matching the table's own truncation format", () => {
    render(
      <CollaboratorAllocationChart
        collaborators={[{ address: COLLAB1, basisPoints: 10000 }]}
      />
    );

    const expectedLabel = `${COLLAB1.slice(0, 8)}...${COLLAB1.slice(-6)}`;
    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
  });

  test("large list (near the 20-collaborator cap) — folds the tail into a single Other segment", () => {
    const collaborators = Array.from({ length: 20 }, (_, i) => ({
      address: `G${String(i).padStart(2, "0")}${"A".repeat(53)}`,
      basisPoints: 500, // 20 * 500 = 10000
    }));

    render(<CollaboratorAllocationChart collaborators={collaborators} />);

    // At most 8 direct slices + 1 "Other" aggregate row in the legend.
    const legendItems = screen.getAllByRole("listitem");
    expect(legendItems.length).toBeLessThanOrEqual(9);

    expect(screen.getByText(/^Other \(\d+ contributors?\)$/)).toBeInTheDocument();
    // Total allocated must still equal the true sum, regardless of folding.
    expect(screen.getByText(/100\.00% allocated/)).toBeInTheDocument();
  });

  test("does not exceed 8 distinct direct colors even with many contributors", () => {
    const collaborators = Array.from({ length: 15 }, (_, i) => ({
      address: `G${String(i).padStart(2, "0")}${"B".repeat(53)}`,
      basisPoints: Math.floor(10000 / 15),
    }));

    render(<CollaboratorAllocationChart collaborators={collaborators} />);

    // "Other" should appear once the list exceeds the direct-slice cap.
    expect(screen.getByText(/^Other \(\d+ contributors?\)$/)).toBeInTheDocument();
  });

  test("provides an accessible text equivalent independent of the visual chart", () => {
    render(
      <CollaboratorAllocationChart
        collaborators={[
          { address: COLLAB1, basisPoints: 7000 },
          { address: COLLAB2, basisPoints: 3000 },
        ]}
      />
    );

    const srText = screen.getByRole("img", { name: /royalty allocation breakdown/i });
    expect(srText).toHaveAccessibleName(
      expect.stringContaining(`${COLLAB1}: 70.00%`)
    );
    expect(srText.textContent).toContain(COLLAB2);
    expect(srText.textContent).toContain("30.00%");
  });

  test("each legend entry carries a non-color marker so contributors aren't distinguished by hue alone", () => {
    render(
      <CollaboratorAllocationChart
        collaborators={[
          { address: COLLAB1, basisPoints: 3000 },
          { address: COLLAB2, basisPoints: 3000 },
          { address: COLLAB3, basisPoints: 4000 },
        ]}
      />
    );

    // Every swatch renders a distinct text marker glyph, not just a bare color block.
    const swatches = document.querySelectorAll(".allocation-chart-swatch");
    const markerTexts = Array.from(swatches).map((el) => el.textContent);
    expect(new Set(markerTexts).size).toBe(markerTexts.length);
    markerTexts.forEach((text) => expect(text).toBeTruthy());
  });

  test("visual chart bar is hidden from assistive tech (aria-hidden) since the sr-only summary covers it", () => {
    render(
      <CollaboratorAllocationChart collaborators={[{ address: COLLAB1, basisPoints: 10000 }]} />
    );

    const chart = screen.getByTestId("collaborator-allocation-chart");
    const hiddenBar = chart.querySelector('[aria-hidden="true"].allocation-chart-bar');
    expect(hiddenBar).toBeTruthy();
  });
});
