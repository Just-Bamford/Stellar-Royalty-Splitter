import { describe, test, expect } from "@jest/globals";
import express from "express";
import compression from "compression";
import request from "supertest";

// Mirrors the compression middleware wiring in src/index.js (#766): gzip
// responses over 1KB, skip when the client sends x-no-compression.
function buildApp() {
  const app = express();
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) => {
        if (req.headers["x-no-compression"]) return false;
        return compression.filter(req, res);
      },
    })
  );
  app.get("/large", (_req, res) => {
    res.json({ data: "x".repeat(5000) });
  });
  app.get("/small", (_req, res) => {
    res.json({ data: "ok" });
  });
  return app;
}

describe("Response compression (#766)", () => {
  test("compresses responses larger than the 1KB threshold", async () => {
    const res = await request(buildApp())
      .get("/large")
      .set("Accept-Encoding", "gzip");

    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.body.data).toBe("x".repeat(5000));
  });

  test("leaves small responses uncompressed", async () => {
    const res = await request(buildApp())
      .get("/small")
      .set("Accept-Encoding", "gzip");

    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body.data).toBe("ok");
  });

  test("honors x-no-compression to opt a client out of compression", async () => {
    const res = await request(buildApp())
      .get("/large")
      .set("Accept-Encoding", "gzip")
      .set("x-no-compression", "1");

    expect(res.headers["content-encoding"]).toBeUndefined();
  });

});
