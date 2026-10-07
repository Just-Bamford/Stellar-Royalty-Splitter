import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { EarningsForecast } from "./EarningsForecast";

describe("EarningsForecast Component", () => {
  it("renders inputs and updates forecast on parameter change", async () => {
    render(<EarningsForecast contractId="C123" />);

    expect(screen.getByText(/Earnings Forecast Simulator/i)).toBeInTheDocument();
    expect(screen.getByTestId("frequency-select")).toBeInTheDocument();
    expect(screen.getByTestId("avg-payout-input")).toBeInTheDocument();
    expect(screen.getByTestId("secondary-vol-input")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("forecast-results")).toBeInTheDocument();
    });

    const avgInput = screen.getByTestId("avg-payout-input");
    fireEvent.change(avgInput, { target: { value: "500" } });

    await waitFor(() => {
      expect(screen.getByTestId("forecast-chart")).toBeInTheDocument();
    });
  });
});
