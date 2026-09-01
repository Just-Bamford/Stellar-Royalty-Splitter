import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useErrorHandler } from "../useErrorHandler";
import { logErrorSafely } from "../../lib/error-logger";

vi.mock("../../lib/error-logger", () => ({
  logErrorSafely: vi.fn(),
}));

describe("useErrorHandler Hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should initialize with no error", () => {
    const { result } = renderHook(() => useErrorHandler());

    expect(result.current.error).toBeNull();
    expect(result.current.errorId).toBe("");
    expect(result.current.isRecovering).toBe(false);
  });

  it("should handle errors", () => {
    const { result } = renderHook(() => useErrorHandler());
    const testError = new Error("Test error");

    act(() => {
      result.current.handleError(testError);
    });

    expect(result.current.error).toBe(testError);
    expect(result.current.errorId).toMatch(/^err_\d+_\w+$/);
  });

  it("should reset error state", () => {
    const { result } = renderHook(() => useErrorHandler());
    const testError = new Error("Test error");

    act(() => {
      result.current.handleError(testError);
    });

    expect(result.current.error).not.toBeNull();

    act(() => {
      result.current.resetError();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.errorId).toBe("");
    expect(result.current.isRecovering).toBe(false);
  });

  it("should recover from error with async delay", async () => {
    const { result } = renderHook(() => useErrorHandler());
    const testError = new Error("Test error");

    act(() => {
      result.current.handleError(testError);
    });

    expect(result.current.isRecovering).toBe(false);

    const recoverPromise = act(async () => {
      await result.current.recoverError();
    });

    await recoverPromise;

    expect(result.current.error).toBeNull();
    expect(result.current.isRecovering).toBe(false);
  });

  it("should call custom error handler when provided", () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useErrorHandler({ onError }));
    const testError = new Error("Test error");

    act(() => {
      result.current.handleError(testError);
    });

    expect(onError).toHaveBeenCalledWith(testError);
  });

  it("should accept error level option", () => {
    const { result } = renderHook(() => useErrorHandler({ level: "feature" }));
    const testError = new Error("Test error");

    act(() => {
      result.current.handleError(testError);
    });

    expect(result.current.error).toBe(testError);
  });

  it("should include context when handling errors", () => {
    const { result } = renderHook(() => useErrorHandler());
    const testError = new Error("Test error");
    const context = "Dashboard component";

    act(() => {
      result.current.handleError(testError, context);
    });

    expect(result.current.error).toBe(testError);
  });

  it("should generate unique error IDs for each error", () => {
    const { result: result1 } = renderHook(() => useErrorHandler());
    const { result: result2 } = renderHook(() => useErrorHandler());

    const error1 = new Error("Error 1");
    const error2 = new Error("Error 2");

    act(() => {
      result1.current.handleError(error1);
    });

    act(() => {
      result2.current.handleError(error2);
    });

    expect(result1.current.errorId).not.toBe(result2.current.errorId);
  });

  it("should handle multiple error resets", () => {
    const { result } = renderHook(() => useErrorHandler());
    const testError = new Error("Test error");

    // First error cycle
    act(() => {
      result.current.handleError(testError);
    });

    act(() => {
      result.current.resetError();
    });

    // Second error cycle
    act(() => {
      result.current.handleError(testError);
    });

    expect(result.current.error).toBe(testError);
    expect(result.current.errorId).toMatch(/^err_\d+_\w+$/);
  });

  it("should log errors safely", () => {
    const { result } = renderHook(() => useErrorHandler({ level: "app" }));
    const testError = new Error("Test error");

    act(() => {
      result.current.handleError(testError);
    });

    expect(logErrorSafely).toHaveBeenCalled();
  });

  it("should handle errors during recovery", async () => {
    const { result } = renderHook(() => useErrorHandler());
    const testError = new Error("Test error");

    act(() => {
      result.current.handleError(testError);
    });

    expect(result.current.isRecovering).toBe(false);

    const recoverPromise = act(async () => {
      await result.current.recoverError();
    });

    await recoverPromise;

    expect(result.current.error).toBeNull();
  });

  it("should support custom error handler options", () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useErrorHandler({
        level: "feature",
        onError,
      }),
    );

    const testError = new Error("Custom error");

    act(() => {
      result.current.handleError(testError);
    });

    expect(onError).toHaveBeenCalledWith(testError);
    expect(result.current.error).toBe(testError);
  });
});
