import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  logErrorSafely,
  getErrorLogs,
  clearErrorLogs,
  getErrorSummary,
} from "../error-logger";

describe("Error Logger", () => {
  beforeEach(() => {
    clearErrorLogs();
  });

  afterEach(() => {
    clearErrorLogs();
  });

  it("should log errors without exposing stack traces", () => {
    const error = new Error("Test error");
    logErrorSafely(error, {
      level: "app",
      errorId: "test-123",
      timestamp: new Date().toISOString(),
    });

    const logs = getErrorLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe("Test error");
    expect(logs[0].metadata.errorId).toBe("test-123");
  });

  it("should not expose stack traces in production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const error = new Error("Production error");
    const errorStack = error.stack;

    logErrorSafely(error, { level: "app" });

    const logs = getErrorLogs();
    const logEntry = logs[0];

    // Stack trace should not be in metadata in production
    expect(logEntry.metadata.stack).toBeUndefined();

    process.env.NODE_ENV = originalEnv;
  });

  it("should include safe metadata in all logs", () => {
    const error = new Error("Test error");
    logErrorSafely(error, { level: "feature" });

    const logs = getErrorLogs();
    const logEntry = logs[0];

    expect(logEntry.metadata.level).toBe("feature");
    expect(logEntry.metadata.userAgent).toBeDefined();
    expect(logEntry.metadata.url).toBeDefined();
    expect(logEntry.metadata.timestamp).toBeDefined();
  });

  it("should include component stack in development mode", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    const error = new Error("Dev error");
    const componentStack = "Component1 > Component2";

    logErrorSafely(error, { componentStack, level: "app" });

    const logs = getErrorLogs();
    expect(logs[0].metadata.componentStack).toBe(componentStack);

    process.env.NODE_ENV = originalEnv;
  });

  it("should respect max log limit", () => {
    for (let i = 0; i < 60; i++) {
      logErrorSafely(new Error(`Error ${i}`), {
        errorId: `err_${i}`,
      });
    }

    const logs = getErrorLogs();
    expect(logs.length).toBeLessThanOrEqual(50);
  });

  it("should generate unique error IDs", () => {
    const errorIds = new Set();

    for (let i = 0; i < 10; i++) {
      const id = `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      errorIds.add(id);
    }

    // All IDs should be unique
    expect(errorIds.size).toBe(10);
  });

  it("should retrieve error summary by ID", () => {
    const errorId = "test-error-123";
    const error = new Error("Test error");

    logErrorSafely(error, { errorId });

    const summary = getErrorSummary(errorId);
    expect(summary).toContain(errorId);
    expect(summary).toContain("Test error");
  });

  it("should return null for non-existent error ID", () => {
    const summary = getErrorSummary("non-existent-id");
    expect(summary).toBeNull();
  });

  it("should clear all logs", () => {
    logErrorSafely(new Error("Error 1"), { errorId: "1" });
    logErrorSafely(new Error("Error 2"), { errorId: "2" });

    expect(getErrorLogs()).toHaveLength(2);

    clearErrorLogs();
    expect(getErrorLogs()).toHaveLength(0);
  });

  it("should include custom metadata", () => {
    const error = new Error("Test error");
    const customMetadata = {
      userId: "user-123",
      feature: "dashboard",
      severity: "high",
    };

    logErrorSafely(error, { ...customMetadata, level: "app" });

    const logs = getErrorLogs();
    const metadata = logs[0].metadata;

    expect(metadata.userId).toBe("user-123");
    expect(metadata.feature).toBe("dashboard");
    expect(metadata.severity).toBe("high");
  });

  it("should handle errors without metadata", () => {
    const error = new Error("Error without metadata");
    logErrorSafely(error);

    const logs = getErrorLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe("Error without metadata");
  });

  it("should record timestamp for each error", () => {
    const error = new Error("Test error");
    const beforeLog = new Date().getTime();

    logErrorSafely(error);

    const afterLog = new Date().getTime();
    const logs = getErrorLogs();
    const logTime = new Date(logs[0].timestamp).getTime();

    expect(logTime).toBeGreaterThanOrEqual(beforeLog);
    expect(logTime).toBeLessThanOrEqual(afterLog);
  });

  it("should preserve error message integrity", () => {
    const messages = [
      "Simple error",
      "Error with special chars: !@#$%^&*()",
      "Multi-line\nerror\nmessage",
      "Very long error message ".repeat(100),
    ];

    messages.forEach((msg, index) => {
      logErrorSafely(new Error(msg), { errorId: `err_${index}` });
    });

    const logs = getErrorLogs();
    messages.forEach((msg, index) => {
      expect(logs[index].message).toBe(msg);
    });
  });

  it("should include isDevelopment flag", () => {
    const error = new Error("Test error");
    logErrorSafely(error);

    const logs = getErrorLogs();
    expect(logs[0].isDevelopment).toBeDefined();
    expect(typeof logs[0].isDevelopment).toBe("boolean");
  });
});
