let isShuttingDown = false;

export function isServerShuttingDown() {
  return isShuttingDown;
}

export function shutdownMiddleware(req, res, next) {
  if (isShuttingDown) {
    res.set("Connection", "close");
    return res.status(503).json({
      error: "Service unavailable: server is shutting down",
    });
  }
  next();
}

export function createGracefulShutdownHandler({
  server,
  closeDatabase,
  logger,
  onShutdown,
  exit = process.exit,
  timeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? "10000", 10),
}) {
  return function handleShutdown(signal) {
    if (isShuttingDown) {
      logger.info(`${signal} received while shutdown is already in progress`);
      return;
    }

    isShuttingDown = true;
    logger.info(`${signal} received - starting graceful shutdown`);

    let forceTimeout = null;
    if (timeoutMs > 0) {
      forceTimeout = setTimeout(() => {
        logger.error(`Graceful shutdown timed out after ${timeoutMs}ms - forcing exit`);
        try {
          if (onShutdown) onShutdown();
          closeDatabase();
        } catch (err) {
          logger.error("Error during force shutdown cleanup", err);
        }
        exit(1);
      }, timeoutMs);
      if (typeof forceTimeout.unref === "function") {
        forceTimeout.unref();
      }
    }

    server.close((serverErr) => {
      if (forceTimeout) {
        clearTimeout(forceTimeout);
      }

      if (serverErr) {
        logger.error("Error while closing HTTP server", serverErr);
      } else {
        logger.info("HTTP server closed after pending requests completed");
      }

      try {
        if (onShutdown) onShutdown();
        closeDatabase();
        logger.info("Database connection closed");
      } catch (dbErr) {
        logger.error("Error while closing database", dbErr);
      }

      logger.info("Graceful shutdown complete");
      exit(serverErr ? 1 : 0);
    });
  };
}

export function resetShutdownStateForTests() {
  isShuttingDown = false;
}

