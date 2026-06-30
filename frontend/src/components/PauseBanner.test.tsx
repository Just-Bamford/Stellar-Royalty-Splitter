import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PauseBanner, { formatCountdown } from "./PauseBanner";
import type { PauseState } from "../api";

const paused: PauseState = {
  paused: true,
  pauseTimestamp: 1_700_000_000,
  pauseSource: "GSOURCE",
  remainingSeconds: 3661,
};

describe("PauseBanner (#504)", () => {
  it("renders nothing when the contract is not paused", () => {
    const { container } = render(
      <PauseBanner pauseState={{ ...paused, paused: false }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the banner and an emergency-pause countdown", () => {
    render(<PauseBanner pauseState={paused} />);
    expect(screen.getByTestId("pause-banner")).toBeInTheDocument();
    expect(screen.getByText(/01:01:01/)).toBeInTheDocument();
  });

  it("formats seconds as HH:MM:SS / MM:SS", () => {
    expect(formatCountdown(3661)).toBe("01:01:01");
    expect(formatCountdown(75)).toBe("01:15");
    expect(formatCountdown(-5)).toBe("00:00");
  });
});
