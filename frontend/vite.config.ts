import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), visualizer()],
  resolve: {
    alias: {
      // `shared/stellar-address.js` lives at the repo root (imported from
      // frontend/src) and imports @stellar/stellar-sdk — Node's resolution
      // cannot find frontend/node_modules from outside the package root, so
      // point the bare specifier at our own install explicitly.
      "@stellar/stellar-sdk": path.resolve(
        __dirname,
        "node_modules/@stellar/stellar-sdk",
      ),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
  build: {
    chunkSizeWarningLimit: 300,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) return id.includes("recharts") ? "recharts" : "vendor";
        },
      },
    },
  },
});