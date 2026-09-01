import React, { ReactNode, Component, ErrorInfo } from "react";
import { logErrorSafely } from "../lib/error-logger";
import "./ErrorBoundary.css";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  level?: "app" | "feature";
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorId: string;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorId: "",
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
      errorId: `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const level = this.props.level || "app";

    // Log error with safe metadata (no stack traces exposed)
    logErrorSafely(error, {
      componentStack: errorInfo.componentStack,
      level,
      errorId: this.state.errorId,
      timestamp: new Date().toISOString(),
    });

    // Call custom error handler if provided
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorId: "" });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const level = this.props.level || "app";

      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          className={`error-boundary-container error-boundary-${level}`}
          role="alert"
          aria-live="assertive"
        >
          <div className="error-boundary-content">
            <div className="error-boundary-icon">⚠️</div>
            <h1>
              {level === "feature"
                ? "Feature temporarily unavailable"
                : "Something went wrong"}
            </h1>
            <p>
              {level === "feature"
                ? "This feature encountered an error and is temporarily unavailable. Your other pages are working normally."
                : "An unexpected error occurred. Please try reloading the page or contact support if the problem persists."}
            </p>

            <div className="error-boundary-actions">
              {level === "feature" ? (
                <button
                  onClick={this.handleRetry}
                  className="error-boundary-button error-boundary-button-primary"
                  aria-label="Try Again"
                >
                  Try Again
                </button>
              ) : (
                <>
                  <button
                    onClick={this.handleRetry}
                    className="error-boundary-button error-boundary-button-primary"
                    aria-label="Try Again"
                  >
                    Try Again
                  </button>
                  <button
                    onClick={this.handleReload}
                    className="error-boundary-button error-boundary-button-secondary"
                    aria-label="Reload the page"
                  >
                    Reload Page
                  </button>
                </>
              )}
            </div>

            {process.env.NODE_ENV === "development" && (
              <details className="error-details">
                <summary>Error details (development only)</summary>
                <pre>{this.state.error?.message}</pre>
              </details>
            )}

            <p className="error-boundary-id">
              Error ID: <code>{this.state.errorId}</code>
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
