/**
 * Safe error logging utility that logs errors without exposing sensitive data
 * or stack traces to users. Only safe metadata is logged.
 */

interface ErrorMetadata {
  componentStack?: string;
  level?: "app" | "feature";
  errorId?: string;
  timestamp?: string;
  userAgent?: string;
  url?: string;
  [key: string]: unknown;
}

interface ErrorLog {
  message: string;
  metadata: ErrorMetadata;
  isDevelopment: boolean;
  timestamp: string;
}

const MAX_LOGS = 50;
let errorLogs: ErrorLog[] = [];

/**
 * Log an error safely without exposing stack traces or sensitive data
 * In production, only safe metadata is logged. Stack traces are available in dev only.
 */
export function logErrorSafely(
  error: Error,
  metadata: ErrorMetadata = {},
): void {
  // Prepare safe error metadata (no stack traces or sensitive data in production)
  const safeMetadata: ErrorMetadata = {
    ...metadata,
    level: metadata.level || "app",
    errorId: metadata.errorId,
    timestamp: metadata.timestamp || new Date().toISOString(),
    userAgent:
      typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    url: typeof window !== "undefined" ? window.location.href : "unknown",
  };

  if (process.env.NODE_ENV === "production") {
    delete safeMetadata.stack;
  }

  const errorLog: ErrorLog = {
    message: error.message,
    metadata: safeMetadata,
    isDevelopment: false,
    timestamp: new Date().toISOString(),
  };

  // Store in memory (max 50 logs)
  errorLogs.push(errorLog);
  if (errorLogs.length > MAX_LOGS) {
    errorLogs = errorLogs.slice(-MAX_LOGS);
  }

  // Log to console
  console.error("[ErrorBoundary]", error.message);
  if (metadata.componentStack) {
    console.error("[ComponentStack]", metadata.componentStack);
  }

  // Send to error tracking service (e.g., Sentry, LogRocket)
  // This should be configured and optional
  if (typeof window !== "undefined") {
    const w = window as unknown as Record<string, unknown>;
    if (w.__errorTrackingEnabled) {
      sendToErrorTracker(errorLog);
    }
  }
}

/**
 * Get all error logs (useful for debugging sessions)
 */
export function getErrorLogs(): ErrorLog[] {
  return [...errorLogs];
}

/**
 * Clear error logs
 */
export function clearErrorLogs(): void {
  errorLogs = [];
}

/**
 * Send error to external error tracking service
 * Implement this based on your error tracking solution
 */
function sendToErrorTracker(_errorLog: ErrorLog): void {
  // Example: Send to Sentry, LogRocket, or custom backend
  try {
    // Placeholder for external error tracking
    // fetch('/api/errors', {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify(errorLog),
    // }).catch(() => {
    //   // Silently fail if error tracking is unavailable
    // });
  } catch (err) {
    // Prevent error tracking from causing additional errors
    console.error("Failed to send error to tracking service");
  }
}

/**
 * Create a safe error summary for debugging (no sensitive data)
 */
export function getErrorSummary(errorId: string): string | null {
  const log = errorLogs.find((l) => l.metadata.errorId === errorId);
  if (!log) return null;

  return `
Error ID: ${errorId}
Time: ${log.timestamp}
Level: ${log.metadata.level}
Message: ${log.message}
URL: ${log.metadata.url}
  `.trim();
}
