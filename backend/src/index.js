// dotenv is optional - load .env file if needed
// import "dotenv/config";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import logger from "./logger.js";
import { initializeRouter } from "./routes/initialize.js";
import { distributeRouter } from "./routes/distribute.js";
import { collaboratorsRouter } from "./routes/collaborators.js";
import { secondaryRoyaltyRouter } from "./routes/secondary-royalty.js";
import historyRouter from "./routes/history.js";
import { analyticsRouter } from "./routes/analytics.js";
import { contractRouter } from "./routes/contract.js";
import { initializeDatabase, getMigrationVersion } from "./database.js";

// Initialize database on startup
initializeDatabase();

const app = express();

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`, {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration,
    });
  });
  next();
});

// Security headers
app.use(helmet());

// CORS restricted to configured frontend origin
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
    methods: ["GET", "POST"],
  }),
);

// General rate limiter: 100 req / 15 min per IP (skips /api/health)
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "900000"),
  max: parseInt(process.env.RATE_LIMIT_MAX ?? "100"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: (req) => req.path === "/api/health",
});

// Write limiter: 10 req / 1 min per IP
const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_WRITE_MAX ?? "10"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many write requests, please slow down." },
});

app.use(generalLimiter);
app.use(express.json({ limit: "10kb" }));

// Enforce Content-Type: application/json on POST requests
app.use((req, res, next) => {
  if (req.method === "POST" && !req.is("application/json")) {
    return res.status(415).json({ error: "Content-Type must be application/json" });
  }
  next();
});

// Apply write limiter to mutating endpoints
app.use("/api/v1/initialize", writeLimiter);
app.use("/api/v1/distribute", writeLimiter);
app.use("/api/v1/secondary-royalty", writeLimiter);

app.use("/api/v1/initialize", initializeRouter);
app.use("/api/v1/distribute", distributeRouter);
app.use("/api/v1/collaborators", collaboratorsRouter);
app.use("/api/v1/secondary-royalty", secondaryRoyaltyRouter);
app.use("/api/v1", historyRouter);
app.use("/api/v1", analyticsRouter);

// Health check
app.get("/api/v1/health", (_req, res) =>
  res.json({ ok: true, dbVersion: getMigrationVersion() }),
);

// Legacy /api/* redirect to /api/v1/*
app.use("/api", (req, res) => {
  res.redirect(308, `/api/v1${req.url}`);
});

// Central error handler
app.use((err, _req, res, _next) => {
  logger.error(err);
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () =>
  logger.info(`API listening on http://localhost:${PORT}`),
);
