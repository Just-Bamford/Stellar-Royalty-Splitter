import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OnboardingWalkthrough } from "./OnboardingWalkthrough";

const STORAGE_KEY = "srs_onboarding_completed";

describe("OnboardingWalkthrough", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("shows on first mount when not previously completed", () => {
    render(<OnboardingWalkthrough />);
    expect(screen.getByText("Initialize Your Contract")).toBeInTheDocument();
  });

  test("does not show when already completed", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    render(<OnboardingWalkthrough />);
    expect(screen.queryByText("Initialize Your Contract")).not.toBeInTheDocument();
  });

  test("skip sets localStorage and hides the tour", () => {
    const onComplete = vi.fn();
    render(<OnboardingWalkthrough onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: /Skip/i }));

    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
    expect(onComplete).toHaveBeenCalled();
    expect(screen.queryByText("Initialize Your Contract")).not.toBeInTheDocument();
  });

  test("Previous is unavailable on the first step, and Next advances steps", () => {
    render(<OnboardingWalkthrough />);

    expect(screen.queryByRole("button", { name: /Previous/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Next/i }));
    expect(screen.getByText("Add Collaborators")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Previous/i }));
    expect(screen.getByText("Initialize Your Contract")).toBeInTheDocument();
  });

  test("bumping restartSignal reopens the tour from step 1, even after completion", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const { rerender } = render(<OnboardingWalkthrough restartSignal={0} />);
    expect(screen.queryByText("Initialize Your Contract")).not.toBeInTheDocument();

    rerender(<OnboardingWalkthrough restartSignal={1} />);
    expect(screen.getByText("Initialize Your Contract")).toBeInTheDocument();
  });
});
