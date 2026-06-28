export function createGracefulShutdownHandler({
  server,
  closeDatabase,
  logger,
  exit = process.exit,
}) {
  let shutdownStarted = false;

  return function handleShutdown(signal) {
    if (shutdownStarted) {
      logger.info(`${signal} received while shutdown is already in progress`);
      return;
    }

    shutdownStarted = true;
    logger.info(`${signal} received - starting graceful shutdown`);

    server.close((serverErr) => {
      if (serverErr) {
        logger.error("Error while closing HTTP server", serverErr);
      } else {
        logger.info("HTTP server closed after pending requests completed");
      }

      try {
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
