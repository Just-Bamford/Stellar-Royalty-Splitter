/**
 * Tests for multi-format dashboard export (#770): filename convention,
 * CSV/JSON formatting, and PDF pagination math.
 */

import { describe, test, expect, vi } from "vitest";
import {
  buildExportFilename,
  buildDashboardCSV,
  buildDashboardJSON,
  exportElementToPDF,
} from "./dashboardExport";

describe("buildExportFilename", () => {
  test("follows the dashboard-{contractId}-{date}.{ext} pattern", () => {
    const name = buildExportFilename({ contractId: "CABCDEFGH123456" }, "pdf");
    const today = new Date().toISOString().split("T")[0];
    expect(name).toBe(`dashboard-CABCDEFG-${today}.pdf`);
  });

  test("falls back to 'all' when no contract is selected (aggregated view)", () => {
    const name = buildExportFilename({ contractId: "" }, "csv");
    expect(name).toMatch(/^dashboard-all-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe("buildDashboardCSV", () => {
  test("produces a header row plus one row per record", () => {
    const csv = buildDashboardCSV(
      [
        { address: "GABC", totalEarned: 150, payoutCount: 3 },
        { address: "GDEF", totalEarned: 50, payoutCount: 1 },
      ],
      [
        { key: "address", label: "Address" },
        { key: "totalEarned", label: "Total Earned" },
        { key: "payoutCount", label: "Payouts" },
      ],
    );

    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Address,Total Earned,Payouts");
    expect(lines[1]).toBe("GABC,150,3");
    expect(lines[2]).toBe("GDEF,50,1");
  });

  test("escapes fields containing commas, quotes, or newlines", () => {
    const csv = buildDashboardCSV(
      [{ note: 'contains, a "quote"\nand newline' }],
      [{ key: "note", label: "Note" }],
    );
    expect(csv).toBe('Note\n"contains, a ""quote""\nand newline"');
  });

  test("renders null/undefined values as empty fields", () => {
    const csv = buildDashboardCSV(
      [{ value: null }, { value: undefined }],
      [{ key: "value", label: "Value" }],
    );
    expect(csv).toBe("Value\n\n");
  });
});

describe("buildDashboardJSON", () => {
  test("wraps dashboard data with contractId, period, and generatedAt metadata", () => {
    const json = buildDashboardJSON(
      { contractId: "CABC", periodStart: "2026-07-01", periodEnd: "2026-07-31" },
      { totalDistributed: 1000 },
    );
    const parsed = JSON.parse(json);

    expect(parsed.contractId).toBe("CABC");
    expect(parsed.period).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    expect(typeof parsed.generatedAt).toBe("string");
    expect(new Date(parsed.generatedAt).toString()).not.toBe("Invalid Date");
    expect(parsed.totalDistributed).toBe(1000);
  });

  test("defaults period bounds to null when not provided", () => {
    const json = buildDashboardJSON({ contractId: "CABC" }, {});
    const parsed = JSON.parse(json);
    expect(parsed.period).toEqual({ start: null, end: null });
  });
});

describe("exportElementToPDF pagination", () => {
  function fakePdf(pageWidth: number, pageHeight: number) {
    const calls: Array<{ type: "addImage" | "addPage"; args?: unknown[] }> = [];
    return {
      pdf: {
        internal: { pageSize: { getWidth: () => pageWidth, getHeight: () => pageHeight } },
        addImage: (...args: unknown[]) => calls.push({ type: "addImage", args }),
        addPage: () => calls.push({ type: "addPage" }),
        save: vi.fn(),
      },
      calls,
    };
  }

  test("renders a single page when the content fits within one page height", async () => {
    const { pdf, calls } = fakePdf(600, 800);
    await exportElementToPDF(document.createElement("div"), "out.pdf", {
      captureCanvas: async () => ({
        width: 600,
        height: 700, // scales to imgHeight <= pageHeight
        toDataURL: () => "data:image/png;base64,xxx",
      }),
      createPdf: () => pdf,
    });

    expect(calls.filter((c) => c.type === "addPage")).toHaveLength(0);
    expect(calls.filter((c) => c.type === "addImage")).toHaveLength(1);
    expect(pdf.save).toHaveBeenCalledWith("out.pdf");
  });

  test("splits tall content across multiple pages", async () => {
    const { pdf, calls } = fakePdf(600, 800);
    // canvas height maps to an image height of ~2400pt at this width — spans 3 pages of 800pt each.
    await exportElementToPDF(document.createElement("div"), "tall.pdf", {
      captureCanvas: async () => ({
        width: 600,
        height: 2400,
        toDataURL: () => "data:image/png;base64,xxx",
      }),
      createPdf: () => pdf,
    });

    expect(calls.filter((c) => c.type === "addPage")).toHaveLength(2);
    expect(calls.filter((c) => c.type === "addImage")).toHaveLength(3);
  });
});
