/**
 * Simple frontend logger utility for debugging and error tracking.
 * Provides consistent logging across the application.
 */

interface LogContext {
  [key: string]: any;
}

const isDev = import.meta.env.DEV;

const logger = {
  /**
   * Log informational message
   */
  info: (message: string, context?: LogContext) => {
    if (isDev) {
      console.log(`[INFO] ${message}`, context);
    }
  },

  /**
   * Log warning message
   */
  warn: (message: string, context?: LogContext) => {
    console.warn(`[WARN] ${message}`, context);
  },

  /**
   * Log error message
   */
  error: (message: string, context?: LogContext) => {
    console.error(`[ERROR] ${message}`, context);
  },

  /**
   * Log debug message (dev only)
   */
  debug: (message: string, context?: LogContext) => {
    if (isDev) {
      console.debug(`[DEBUG] ${message}`, context);
    }
  },
};

export default logger;
