// Minimal Express app for testing — no DB init, no listen
import express from "express";
import { initializeRouter } from "../src/routes/initialize.js";
import { distributeRouter } from "../src/routes/distribute.js";
import { collaboratorsRouter } from "../src/routes/collaborators.js";

const app = express();
app.use(express.json());

app.use("/api/v1/initialize", initializeRouter);
app.use("/api/v1/distribute", distributeRouter);
app.use("/api/v1/collaborators", collaboratorsRouter);

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

export default app;
