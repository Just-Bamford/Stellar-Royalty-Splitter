import React, { ReactNode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { ErrorBoundary } from "../ErrorBoundary";
import { FeatureErrorBoundary } from "../FeatureErrorBoundary";
import { logErrorSafely } from "../../lib/error-logger";

// Mock the error logger
vi.mock("../../lib/error-logger", () => ({
  logErrorSafely: vi.fn(),
}));

// Component that throws an error
const ThrowError: React.FC<{ shouldThrow: boolean; message?: string }> = ({
  shouldThrow,
  message = "Test error",
}) => {
  if (shouldThrow) {
    throw new Error(message);
  }
  return <div>Component rendered successfully</div>;
};

// Component with hook that throws
const ThrowOnRender: React.FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
  const [state] = React.useState(() => {
    if (shouldThrow) {
      throw new Error("Error during state initialization");
    }
    return "initialized";
  });
  return <div>{state}</div>;
};

describe("ErrorBoundary", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Suppress console errors during test
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("should render children when there is no error", () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(
      screen.getByText("Component rendered successfully"),
    ).toBeInTheDocument();
  });

  it("should catch errors and display fallback UI", () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(
      screen.getByText(/An unexpected error occurred/i),
    ).toBeInTheDocument();
  });

  it("should display retry button for app-level errors", () => {
    render(
      <ErrorBoundary level="app">
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons).toContainEqual(
      expect.objectContaining({ textContent: "Try Again" }),
    );
    expect(buttons).toContainEqual(
      expect.objectContaining({ textContent: "Reload Page" }),
    );
  });

  it("should display appropriate message for feature-level errors", () => {
    render(
      <ErrorBoundary level="feature">
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(
      screen.getByText("Feature temporarily unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/This feature encountered an error/i),
    ).toBeInTheDocument();
  });

  it("should generate and display error ID", () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );

    const errorIdText = screen.getByText(/Error ID:/);
    expect(errorIdText).toBeInTheDocument();
    expect(errorIdText.textContent).toMatch(/err_\d+_\w+/);
  });

  it("should recover from error when Try Again is clicked", () => {
    const { rerender } = render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();

    // Re-render with shouldThrow=false to simulate recovery
    rerender(
      <ErrorBoundary>
        <ThrowError shouldThrow={false} />
      </ErrorBoundary>,
    );

    const tryAgainButton = screen
      .getAllByRole("button")
      .find((btn) => btn.textContent === "Try Again");
    fireEvent.click(tryAgainButton!);

    expect(
      screen.getByText("Component rendered successfully"),
    ).toBeInTheDocument();
  });

  it("should display custom fallback UI when provided", () => {
    const customFallback = <div>Custom error message</div>;
    render(
      <ErrorBoundary fallback={customFallback}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Custom error message")).toBeInTheDocument();
  });

  it("should call custom error handler when provided", () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <ThrowError shouldThrow={true} message="Custom error" />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalled();
    const [error, errorInfo] = onError.mock.calls[0];
    expect(error.message).toBe("Custom error");
    expect(errorInfo.componentStack).toBeDefined();
  });

  it("should log error safely without stack trace in production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(logErrorSafely).toHaveBeenCalled();

    process.env.NODE_ENV = originalEnv;
  });

  it("should handle errors during state initialization", () => {
    render(
      <ErrorBoundary>
        <ThrowOnRender shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("should have accessible error UI with proper ARIA attributes", () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );

    const alertElement = screen.getByRole("alert");
    expect(alertElement).toHaveAttribute("aria-live", "assertive");
  });

  it("should show development-only error details in development mode", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} message="Test error message" />
      </ErrorBoundary>,
    );

    expect(
      screen.getByText(/Error details \(development only\)/i),
    ).toBeInTheDocument();

    process.env.NODE_ENV = originalEnv;
  });

  it("should hide development-only error details in production mode", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(
      screen.queryByText(/Error details \(development only\)/i),
    ).not.toBeInTheDocument();

    process.env.NODE_ENV = originalEnv;
  });
});

describe("FeatureErrorBoundary", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("should render children when there is no error", () => {
    render(
      <FeatureErrorBoundary featureName="Test Feature">
        <ThrowError shouldThrow={false} />
      </FeatureErrorBoundary>,
    );

    expect(
      screen.getByText("Component rendered successfully"),
    ).toBeInTheDocument();
  });

  it("should catch errors and display feature-level fallback", () => {
    render(
      <FeatureErrorBoundary featureName="Dashboard">
        <ThrowError shouldThrow={true} />
      </FeatureErrorBoundary>,
    );

    expect(screen.getByText("Feature Unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(/Dashboard feature encountered an error/i),
    ).toBeInTheDocument();
  });

  it("should use custom fallback when provided", () => {
    const customFallback = <div>Custom feature fallback</div>;
    render(
      <FeatureErrorBoundary featureName="Dashboard" fallback={customFallback}>
        <ThrowError shouldThrow={true} />
      </FeatureErrorBoundary>,
    );

    expect(screen.getByText("Custom feature fallback")).toBeInTheDocument();
  });

  it("should call custom error handler when provided", () => {
    const onError = vi.fn();
    render(
      <FeatureErrorBoundary featureName="Dashboard" onError={onError}>
        <ThrowError shouldThrow={true} />
      </FeatureErrorBoundary>,
    );

    expect(onError).toHaveBeenCalled();
  });

  it("should isolate feature-level errors from parent components", () => {
    const { rerender } = render(
      <div>
        <div>Parent content</div>
        <FeatureErrorBoundary featureName="Feature 1">
          <ThrowError shouldThrow={true} />
        </FeatureErrorBoundary>
        <div>More content</div>
      </div>,
    );

    expect(screen.getByText("Parent content")).toBeInTheDocument();
    expect(screen.getByText("More content")).toBeInTheDocument();
    expect(
      screen.getByText(/Feature 1 feature encountered an error/i),
    ).toBeInTheDocument();
  });
});

describe("Error Recovery", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("should allow retry recovery in feature boundary", () => {
    const { rerender } = render(
      <FeatureErrorBoundary featureName="Dashboard">
        <ThrowError shouldThrow={true} />
      </FeatureErrorBoundary>,
    );

    expect(
      screen.getByText(/Dashboard feature encountered an error/i),
    ).toBeInTheDocument();

    // Rerender with shouldThrow=false to simulate recovery
    rerender(
      <FeatureErrorBoundary featureName="Dashboard">
        <ThrowError shouldThrow={false} />
      </FeatureErrorBoundary>,
    );

    // Click Try Again
    const tryAgainButton = screen.getByRole("button", { name: /Try Again/i });
    fireEvent.click(tryAgainButton);

    expect(
      screen.getByText("Component rendered successfully"),
    ).toBeInTheDocument();
  });

  it("should isolate errors to prevent cascade failures", () => {
    render(
      <ErrorBoundary>
        <div>
          <FeatureErrorBoundary featureName="Feature A">
            <ThrowError shouldThrow={true} />
          </FeatureErrorBoundary>
          <FeatureErrorBoundary featureName="Feature B">
            <ThrowError shouldThrow={false} />
          </FeatureErrorBoundary>
        </div>
      </ErrorBoundary>,
    );

    expect(
      screen.getByText(/Feature A feature encountered an error/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Component rendered successfully"),
    ).toBeInTheDocument();
  });
});
