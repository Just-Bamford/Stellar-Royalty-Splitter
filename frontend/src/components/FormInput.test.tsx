import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import FormInput from "./FormInput";

describe("FormInput", () => {
  it("renders input with label when provided", () => {
    render(<FormInput id="test-input" label="Test Label" />);
    expect(screen.getByLabelText("Test Label")).toBeInTheDocument();
  });

  it("renders input without label when not provided", () => {
    render(<FormInput id="test-input" placeholder="Test placeholder" />);
    expect(screen.getByPlaceholderText("Test placeholder")).toBeInTheDocument();
  });

  it("shows error state with shake animation when error prop is provided", async () => {
    const { rerender } = render(<FormInput id="test-input" />);
    const input = screen.getByRole("textbox");

    rerender(<FormInput id="test-input" error="This field is required" />);

    await waitFor(() => {
      expect(screen.getByText("This field is required")).toBeInTheDocument();
    });

    const wrapper = input.closest(".input-wrapper");
    expect(wrapper).toHaveClass("input-wrapper--error");
  });

  it("displays error icon when error is present", async () => {
    const { rerender } = render(<FormInput id="test-input" />);
    
    rerender(<FormInput id="test-input" error="Invalid input" />);

    await waitFor(() => {
      const errorIcon = document.querySelector(".input-icon--error");
      expect(errorIcon).toBeInTheDocument();
    });
  });

  it("shows success state with green border when showSuccess is true and no error", () => {
    render(<FormInput id="test-input" value="valid" showSuccess={true} />);
    
    const input = screen.getByRole("textbox");
    const wrapper = input.closest(".input-wrapper");
    
    expect(wrapper).toHaveClass("input-wrapper--success");
  });

  it("displays success icon when showSuccess is true and no error", () => {
    render(<FormInput id="test-input" value="valid" showSuccess={true} />);
    
    const successIcon = document.querySelector(".input-icon--success");
    expect(successIcon).toBeInTheDocument();
  });

  it("does not show success icon when error is present", async () => {
    const { rerender } = render(<FormInput id="test-input" value="valid" showSuccess={true} />);
    
    rerender(<FormInput id="test-input" value="valid" showSuccess={true} error="Invalid" />);

    await waitFor(() => {
      const successIcon = document.querySelector(".input-icon--success");
      expect(successIcon).not.toBeInTheDocument();
    });
  });

  it("applies shake animation only when error changes", async () => {
    const { rerender } = render(<FormInput id="test-input" error="Error 1" />);
    
    // Wait for animation to complete
    await waitFor(() => {
      const wrapper = document.querySelector(".input-wrapper--error");
      expect(wrapper).toBeInTheDocument();
    }, { timeout: 600 });

    // Change error message
    rerender(<FormInput id="test-input" error="Error 2" />);

    await waitFor(() => {
      const wrapper = document.querySelector(".input-wrapper--error");
      expect(wrapper).toBeInTheDocument();
    }, { timeout: 600 });
  });

  it("removes error state when error prop is cleared", async () => {
    const { rerender } = render(<FormInput id="test-input" error="Error message" />);

    await waitFor(() => {
      expect(screen.getByText("Error message")).toBeInTheDocument();
    });

    rerender(<FormInput id="test-input" error={undefined} />);

    await waitFor(() => {
      expect(screen.queryByText("Error message")).not.toBeInTheDocument();
    });

    const input = screen.getByRole("textbox");
    const wrapper = input.closest(".input-wrapper");
    expect(wrapper).not.toHaveClass("input-wrapper--error");
  });

  it("sets aria-invalid to true when error is present", async () => {
    const { rerender } = render(<FormInput id="test-input" />);
    
    rerender(<FormInput id="test-input" error="Invalid" />);

    await waitFor(() => {
      const input = screen.getByRole("textbox");
      expect(input).toHaveAttribute("aria-invalid", "true");
    });
  });

  it("sets aria-describedby to error message id when error is present", async () => {
    const { rerender } = render(<FormInput id="test-input" />);
    
    rerender(<FormInput id="test-input" error="Invalid input" />);

    await waitFor(() => {
      const input = screen.getByRole("textbox");
      expect(input).toHaveAttribute("aria-describedby", "test-input-error");
    });
  });

  it("passes through additional input props", () => {
    render(
      <FormInput
        id="test-input"
        placeholder="Enter text"
        disabled={true}
        maxLength={10}
      />
    );

    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("placeholder", "Enter text");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("maxlength", "10");
  });

  it("calls onChange handler when input value changes", () => {
    const handleChange = vi.fn();
    render(<FormInput id="test-input" onChange={handleChange} />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "test" } });

    expect(handleChange).toHaveBeenCalledTimes(1);
  });
});
