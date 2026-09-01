/**
 * test-utils.tsx — shared test utilities for the Stellar Royalty Splitter frontend.
 *
 * Provides a `render` helper that automatically wraps components in a fresh
 * QueryClientProvider so existing tests don't need to be manually updated
 * after the React Query integration (#832).
 */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach } from "vitest";
// Import from the real node_modules path to avoid the vitest alias loop.
// The alias redirects "@testing-library/react" -> this file, so we must use
// the underlying path to get the actual library exports.
import * as RTL from "@testing-library/react/pure.js";
import type { RenderOptions, RenderResult } from "@testing-library/react/pure.js";

afterEach(() => {
  RTL.cleanup();
});

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        gcTime: 0,
      },
    },
  });
}

/**
 * Drop-in replacement for @testing-library/react's `render` that wraps the
 * component under test in a fresh `QueryClientProvider` with test-friendly
 * defaults (no retries, no staleness, immediate GC).
 */
export function render(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
): RenderResult {
  const queryClient = createTestQueryClient();

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  return RTL.render(ui, { wrapper: Wrapper, ...options });
}

// Re-export everything from the real @testing-library/react so callers can
// import from this module exclusively and get both the wrapped render + all
// utilities (screen, waitFor, fireEvent, renderHook, act, etc.)
export * from "@testing-library/react/pure.js";
