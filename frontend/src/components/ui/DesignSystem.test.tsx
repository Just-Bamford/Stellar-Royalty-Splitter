import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert, Badge, Button, Field } from "./DesignSystem";

describe("design system primitives (#967, #968)", () => {
  it("renders accessible status and action variants", () => {
    render(<><Badge tone="success">Healthy</Badge><Alert tone="danger">Failure</Alert><Button>Continue</Button><Field label="Wallet" error="Required" /></>);
    expect(screen.getByText("Healthy")).toHaveClass("ds-badge--success");
    expect(screen.getByRole("status")).toHaveClass("ds-alert--danger");
    expect(screen.getByRole("button")).toHaveClass("ds-button--primary");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  });
});
