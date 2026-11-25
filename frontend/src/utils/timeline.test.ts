import { describe, expect, it, vi } from "vitest";
import {
  clampOffset,
  fetchAllPages,
  pageRange,
  paginate,
  sortNewestFirst,
} from "./timeline";

const ev = (id: string, timestamp: string) => ({ id, timestamp });

describe("fetchAllPages", () => {
  it("pages until a short page and returns everything", async () => {
    const source = Array.from({ length: 250 }, (_, i) => i);
    const fetchPage = vi.fn(async (limit: number, offset: number) =>
      source.slice(offset, offset + limit),
    );

    const result = await fetchAllPages(fetchPage, 100, 20);

    expect(result.items).toEqual(source);
    expect(result.truncated).toBe(false);
    expect(fetchPage.mock.calls).toEqual([
      [100, 0],
      [100, 100],
      [100, 200],
    ]);
  });

  it("stops after an empty page when the total is an exact multiple of the page size", async () => {
    const source = Array.from({ length: 200 }, (_, i) => i);
    const fetchPage = vi.fn(async (limit: number, offset: number) =>
      source.slice(offset, offset + limit),
    );

    const result = await fetchAllPages(fetchPage, 100, 20);

    expect(result.items).toHaveLength(200);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("handles an empty source", async () => {
    const result = await fetchAllPages(async () => [], 100, 20);
    expect(result).toEqual({ items: [], truncated: false });
  });

  it("reports truncation when the page cap is hit", async () => {
    const result = await fetchAllPages(async (limit) => Array(limit).fill(1), 10, 3);
    expect(result.items).toHaveLength(30);
    expect(result.truncated).toBe(true);
  });

  it("propagates a failing page", async () => {
    await expect(
      fetchAllPages(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("sortNewestFirst", () => {
  it("orders by time, newest first, across both sources", () => {
    const sorted = sortNewestFirst([
      ev("tx-1", "2026-01-01T00:00:00Z"),
      ev("audit-1", "2026-03-01T00:00:00Z"),
      ev("tx-2", "2026-02-01T00:00:00Z"),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["audit-1", "tx-2", "tx-1"]);
  });

  it("keeps the original order for equal timestamps and puts unreadable ones last", () => {
    const sorted = sortNewestFirst([
      ev("a", "2026-01-01T00:00:00Z"),
      ev("bad", "not a date"),
      ev("b", "2026-01-01T00:00:00Z"),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["a", "b", "bad"]);
  });

  it("does not mutate its input", () => {
    const input = [ev("a", "2026-01-01T00:00:00Z"), ev("b", "2026-02-01T00:00:00Z")];
    sortNewestFirst(input);
    expect(input.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("client-side pagination", () => {
  const items = Array.from({ length: 45 }, (_, i) => i + 1);

  it("pages never skip or repeat an item", () => {
    const pages = [0, 20, 40].map((offset) => paginate(items, offset, 20));
    expect(pages.map((p) => p.length)).toEqual([20, 20, 5]);
    expect(pages.flat()).toEqual(items);
    expect(new Set(pages.flat()).size).toBe(items.length);
  });

  it("returns an empty page past the end and treats a negative offset as 0", () => {
    expect(paginate(items, 100, 20)).toEqual([]);
    expect(paginate(items, -5, 3)).toEqual([1, 2, 3]);
  });

  it("clamps an offset that is past the last page", () => {
    expect(clampOffset(100, 45, 20)).toBe(40);
    expect(clampOffset(40, 45, 20)).toBe(40);
    expect(clampOffset(40, 40, 20)).toBe(20);
    expect(clampOffset(20, 0, 20)).toBe(0);
    expect(clampOffset(-3, 45, 20)).toBe(0);
  });

  it("describes the visible range", () => {
    expect(pageRange(0, 20, 45)).toEqual({ from: 1, to: 20 });
    expect(pageRange(40, 20, 45)).toEqual({ from: 41, to: 45 });
    expect(pageRange(0, 20, 0)).toEqual({ from: 0, to: 0 });
  });
});
