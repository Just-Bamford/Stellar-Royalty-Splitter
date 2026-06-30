import { describe, test, expect } from "@jest/globals";
import request from "supertest";
import express from "express";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec, swaggerUiOptions } from "../src/swagger.js";

const app = express();
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));
app.get('/api/docs.json', (_req, res) => res.json(swaggerSpec));

describe("GET /api/docs", () => {
  test("returns 200 or redirect", async () => {
    const res = await request(app).get("/api/docs");
    expect([200, 301, 302]).toContain(res.status);
  });

  test("GET /api/docs.json returns openapi spec with at least 10 paths", async () => {
    const res = await request(app).get("/api/docs.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body.openapi).toBe("3.0.0");
    expect(Object.keys(res.body.paths).length).toBeGreaterThanOrEqual(10);
  });
});
