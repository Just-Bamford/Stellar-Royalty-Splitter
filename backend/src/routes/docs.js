/**
 * API documentation endpoints (#587).
 *
 * GET /api/docs       — Swagger UI (served via CDN, zero extra dependencies)
 * GET /api/docs/json  — Raw OpenAPI 3.0 JSON spec
 */
import { Router } from "express";
import { openApiSpec } from "../swagger.js";

export const docsRouter = Router();

/** Raw OpenAPI spec as JSON */
docsRouter.get("/json", (_req, res) => {
  res.json(openApiSpec);
});

/** Swagger UI powered by the unpkg CDN — no npm package required */
docsRouter.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Stellar Royalty Splitter — API Docs</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/docs/json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      deepLinking: true,
    });
  </script>
</body>
</html>`);
});
