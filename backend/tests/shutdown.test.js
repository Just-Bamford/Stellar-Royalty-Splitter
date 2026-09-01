import { jest } from "@jest/globals";
import {
  createGracefulShutdownHandler,
  shutdownMiddleware,
  resetShutdownStateForTests,
} from "../src/shutdown.js";

describe("graceful shutdown", () => {
  beforeEach(() => {
    resetShutdownStateForTests();
  });

  test("waits for the HTTP server to close before closing the database and exiting", () => {
    let closeCallback;
    const server = {
      close: jest.fn((callback) => {
        closeCallback = callback;
      }),
    };
    const closeDatabase = jest.fn();
    const logger = { info: jest.fn(), error: jest.fn() };
    const exit = jest.fn();

    const handleShutdown = createGracefulShutdownHandler({
      server,
      closeDatabase,
      logger,
      exit,
      timeoutMs: 1000,
    });

    handleShutdown("SIGTERM");

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(closeDatabase).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    closeCallback();

    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.info).toHaveBeenCalledWith(
      "HTTP server closed after pending requests completed",
    );
  });

  test("ignores duplicate shutdown signals while shutdown is in progress", () => {
    const server = {
      close: jest.fn(),
    };
    const logger = { info: jest.fn(), error: jest.fn() };
    const handleShutdown = createGracefulShutdownHandler({
      server,
      closeDatabase: jest.fn(),
      logger,
      exit: jest.fn(),
    });

    handleShutdown("SIGTERM");
    handleShutdown("SIGTERM");

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "SIGTERM received while shutdown is already in progress",
    );
  });

  test("exits non-zero when the HTTP server reports a close error", () => {
    const closeError = new Error("close failed");
    const server = {
      close: jest.fn((callback) => callback(closeError)),
    };
    const closeDatabase = jest.fn();
    const logger = { info: jest.fn(), error: jest.fn() };
    const exit = jest.fn();

    const handleShutdown = createGracefulShutdownHandler({
      server,
      closeDatabase,
      logger,
      exit,
    });

    handleShutdown("SIGTERM");

    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Error while closing HTTP server",
      closeError,
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("shutdownMiddleware allows requests when not shutting down and returns 503 when shutting down", () => {
    const req = {};
    const res = {
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    // Not shutting down
    shutdownMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Trigger shutdown
    const server = { close: jest.fn() };
    const handleShutdown = createGracefulShutdownHandler({
      server,
      closeDatabase: jest.fn(),
      logger: { info: jest.fn(), error: jest.fn() },
      exit: jest.fn(),
    });
    handleShutdown("SIGINT");

    // During shutdown
    const res503 = {
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next2 = jest.fn();
    shutdownMiddleware(req, res503, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(res503.set).toHaveBeenCalledWith("Connection", "close");
    expect(res503.status).toHaveBeenCalledWith(503);
    expect(res503.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("shutting down") })
    );
  });

  test("forces exit with code 1 if server shutdown times out", () => {
    jest.useFakeTimers();
    const server = { close: jest.fn() }; // Never calls callback
    const closeDatabase = jest.fn();
    const logger = { info: jest.fn(), error: jest.fn() };
    const exit = jest.fn();

    const handleShutdown = createGracefulShutdownHandler({
      server,
      closeDatabase,
      logger,
      exit,
      timeoutMs: 5000,
    });

    handleShutdown("SIGTERM");

    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(5001);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Graceful shutdown timed out after 5000ms")
    );
    expect(closeDatabase).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);

    jest.useRealTimers();
  });
});

