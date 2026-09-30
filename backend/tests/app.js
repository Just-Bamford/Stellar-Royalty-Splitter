// Minimal Express app for testing ÔÇö no DB init, no listen
import express from "express";
import { createBodySizeLimiters } from "../src/body-size-limit.js";
import { initializeRouter } from "../src/routes/initialize.js";
import { distributeRouter } from "../src/routes/distribute.js";
import { batchDistributeRouter } from "../src/routes/batch-distribute.js";
import { collaboratorsRouter } from "../src/routes/collaborators.js";
import { simulateRouter } from "../src/routes/simulate.js";
import { metricsRouter } from "../src/routes/metrics.js";
import { notFoundHandler, errorHandler } from "../src/error-response.js";
import { schedulesRouter, batchRouter } from "../src/routes/schedules.js";
import { identityRouter } from "../src/routes/identity.js";
import { backupRouter } from "../src/routes/backup.js";

const app = express();

// Body size limits mirror production: 10 KB JSON, 50 KB multipart (#426)
app.use(...createBodySizeLimiters());

app.use("/api/v1/initialize", initializeRouter);
app.use("/api/v1/distribute", distributeRouter);
app.use("/api/v1/batch-distribute", batchDistributeRouter);
app.use("/api/v1/collaborators", collaboratorsRouter);
app.use("/api/v1/simulate", simulateRouter);
app.use("/metrics", metricsRouter);
app.use("/api/v1/schedules", schedulesRouter);
app.use("/api/v1/batch", batchRouter);
app.use("/api/v1/identity", identityRouter);
app.use("/api/v1/backup", backupRouter);

// Same standard-shape handlers production uses (#662), so tests against
// this harness exercise the real response format instead of a stand-in.
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
