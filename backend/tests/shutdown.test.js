import { jest } from "@jest/globals";
import { createGracefulShutdownHandler } from "../src/shutdown.js";

describe("graceful shutdown", () => {
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
});
