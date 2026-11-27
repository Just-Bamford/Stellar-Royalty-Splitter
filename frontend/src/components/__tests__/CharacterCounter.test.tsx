import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom";
import { CharacterCounter } from "../CharacterCounter";

describe("CharacterCounter", () => {
  it("renders current count and max count", () => {
    render(<CharacterCounter current={50} max={200} testId="test-counter" />);

    const counter = screen.getByTestId("test-counter");
    expect(counter).toHaveTextContent("50/200");
    expect(counter).not.toHaveClass("near-limit");
    expect(counter).not.toHaveClass("at-limit");
  });

  it("applies near-limit class when at or above 90% of max", () => {
    render(<CharacterCounter current={185} max={200} testId="test-counter" />);

    const counter = screen.getByTestId("test-counter");
    expect(counter).toHaveClass("near-limit");
    expect(counter).not.toHaveClass("at-limit");
  });

  it("applies at-limit class when at or exceeding max", () => {
    render(<CharacterCounter current={200} max={200} testId="test-counter" />);

    const counter = screen.getByTestId("test-counter");
    expect(counter).toHaveClass("at-limit");
  });
});
