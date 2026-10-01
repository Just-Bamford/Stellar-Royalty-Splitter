/**
 * API documentation endpoints (#587).
 *
 * GET /api/docs       - Swagger UI (served via CDN, zero extra dependencies)
 * GET /api/docs/json  - Raw OpenAPI 3.0 JSON spec
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
  <style>
    .sandbox-banner {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #fff3cd;
      color: #664d00;
      border: 1px solid #ffe08a;
      border-radius: 6px;
      padding: 12px 16px;
      margin: 16px auto;
      max-width: 1460px;
      font-size: 14px;
      line-height: 1.5;
    }
    .sandbox-banner strong { color: #8a6 000; }
  </style>
</head>
<body>
  <div class="sandbox-banner">
    <strong>Warning: This is a test endpoint.</strong>
    The explorer targets the sandbox environment and uses a test API key.
    Requests are safe to execute and do not affect production data.
  </div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    const TEST_API_KEY = 'test_key_sandbox_explorer';
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/api/docs/json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout: 'BaseLayout',
        deepLinking: true,
        persistAuthorization: true,
        tryItOutEnabled: true,
        onComplete: () => {
          // Pre-authorize the explorer with the sandbox test API key.
          ui.preauth({ apiKey: { Authorization: TEST_API_KEY } });
        },
      });
    };
  </script>
</body>
</html>`);
});
