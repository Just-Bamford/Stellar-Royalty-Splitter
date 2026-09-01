import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@testing-library\/react$/,
        replacement: path.resolve(__dirname, "src/test/test-utils.tsx"),
      },
      {
        find: /^@jest\/globals$/,
        replacement: path.resolve(__dirname, "src/test/jest-globals.ts"),
      },
      {
      // Keep in sync with vite.config.ts: shared/stellar-address.js (repo
      // root) imports @stellar/stellar-sdk, which Node cannot resolve from
      // outside the frontend package root.
        find: "@stellar/stellar-sdk",
        replacement: path.resolve(
          __dirname,
          "node_modules/@stellar/stellar-sdk",
        ),
      },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Playwright specs live under e2e/ and run via `npm run test:e2e` — keep
    // unit/component tests scoped to src/ so the two runners never collide.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      // Excluded because they're generated, config-only, or type-only files
      // that don't reflect meaningful test coverage — matches the #720
      // constraint that coverage shouldn't penalize low-value files.
      exclude: [
        "node_modules/**",
        "dist/**",
        "e2e/**",
        "src/test/**",
        "src/main.tsx",
        "**/*.d.ts",
        "**/*.config.{ts,js}",
        "**/*.{test,spec}.{ts,tsx}",
      ],
    },
  },
});
