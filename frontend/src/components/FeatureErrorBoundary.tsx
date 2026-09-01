import React, { ReactNode, FC, ErrorInfo, useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

interface FeatureErrorBoundaryProps {
  children: ReactNode;
  featureName: string;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

/**
 * Feature-level error boundary that isolates errors to specific features/pages
 * Prevents one feature failure from breaking the entire application
 */
export const FeatureErrorBoundary: FC<FeatureErrorBoundaryProps> = ({
  children,
  featureName,
  fallback,
  onError,
}) => {
  const [retryKey, setRetryKey] = useState(0);

  const handleRetry = () => {
    setRetryKey((prev) => prev + 1);
  };

  return (
    <ErrorBoundary
      key={retryKey}
      level="feature"
      fallback={
        fallback || (
          <div className="feature-error-fallback">
            <div className="feature-error-content">
              <h2>Feature Unavailable</h2>
              <p>
                The {featureName} feature encountered an error. Please try again
                or check back later.
              </p>
              <button
                onClick={handleRetry}
                className="error-boundary-button error-boundary-button-primary"
                aria-label="Try Again"
              >
                Try Again
              </button>
            </div>
          </div>
        )
      }
      onError={(error, errorInfo) => {
        if (onError) {
          onError(error, errorInfo);
        }
      }}
    >
      {children}
    </ErrorBoundary>
  );
};
