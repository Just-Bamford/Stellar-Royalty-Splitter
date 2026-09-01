import { useCallback, useState } from "react";
import { logErrorSafely } from "../lib/error-logger";

interface UseErrorHandlerOptions {
  onError?: (error: Error) => void;
  level?: "app" | "feature";
}

/**
 * Hook to handle errors in functional components
 * Provides safe error logging and recovery mechanisms
 */
export function useErrorHandler(options: UseErrorHandlerOptions = {}) {
  const [error, setError] = useState<Error | null>(null);
  const [errorId, setErrorId] = useState<string>("");
  const [isRecovering, setIsRecovering] = useState(false);

  const handleError = useCallback(
    (err: Error, context?: string) => {
      const newErrorId = `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      setErrorId(newErrorId);
      setError(err);

      // Log error safely
      logErrorSafely(err, {
        level: options.level,
        errorId: newErrorId,
        context,
        timestamp: new Date().toISOString(),
      });

      // Call custom error handler if provided
      if (options.onError) {
        options.onError(err);
      }
    },
    [options],
  );

  const resetError = useCallback(() => {
    setError(null);
    setErrorId("");
    setIsRecovering(false);
  }, []);

  const recoverError = useCallback(async () => {
    setIsRecovering(true);
    try {
      // Give time for async cleanup/recovery
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      resetError();
    } finally {
      setIsRecovering(false);
    }
  }, [resetError]);

  return {
    error,
    errorId,
    isRecovering,
    handleError,
    resetError,
    recoverError,
  };
}
