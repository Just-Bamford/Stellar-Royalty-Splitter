// #770: multi-format dashboard export (PDF / CSV / JSON).
//
// PDF generation renders the dashboard DOM node to a canvas (html2canvas)
// and slices that canvas across as many A4 pages as needed (jsPDF), so long
// dashboards don't get cut off mid-chart. CSV/JSON operate on the same
// plain-data shape the dashboard already holds in state, so those two never
// need to touch the DOM.

export interface DashboardExportMetadata {
  contractId: string;
  periodStart?: string | null;
  periodEnd?: string | null;
}

export function buildExportFilename(
  metadata: DashboardExportMetadata,
  extension: "pdf" | "csv" | "json",
): string {
  const date = new Date().toISOString().split("T")[0];
  const contractPart = metadata.contractId
    ? metadata.contractId.slice(0, 8)
    : "all";
  return `dashboard-${contractPart}-${date}.${extension}`;
}

function escapeCSVField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let str = String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}


/** Builds a CSV table from a list of homogeneous row objects. */
export function buildDashboardCSV<T extends object>(
  rows: T[],
  columns: { key: keyof T; label: string }[],
): string {
  const headerLine = columns.map((c) => escapeCSVField(c.label)).join(",");
  const dataLines = rows.map((row) =>
    columns
      .map((c) => escapeCSVField(row[c.key] as string | number | null | undefined))
      .join(","),
  );
  return [headerLine, ...dataLines].join("\n");
}

/** Wraps arbitrary dashboard data with export metadata for a JSON export. */
export function buildDashboardJSON(
  metadata: DashboardExportMetadata,
  data: Record<string, unknown>,
): string {
  return JSON.stringify(
    {
      contractId: metadata.contractId,
      period: {
        start: metadata.periodStart ?? null,
        end: metadata.periodEnd ?? null,
      },
      generatedAt: new Date().toISOString(),
      ...data,
    },
    null,
    2,
  );
}

export function downloadTextFile(
  content: string,
  filename: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function downloadDashboardCSV(csv: string, filename: string): void {
  downloadTextFile(csv, filename, "text/csv;charset=utf-8;");
}

export function downloadDashboardJSON(json: string, filename: string): void {
  downloadTextFile(json, filename, "application/json;charset=utf-8;");
}

/**
 * Renders a DOM element to a paginated PDF. Kept dependency-injectable
 * (html2canvas/jsPDF passed in) so unit tests can exercise the pagination
 * math without a real browser canvas.
 */
export async function exportElementToPDF(
  element: HTMLElement,
  filename: string,
  deps?: {
    captureCanvas: (el: HTMLElement) => Promise<{ width: number; height: number; toDataURL: (type: string) => string }>;
    createPdf: () => {
      internal: { pageSize: { getWidth(): number; getHeight(): number } };
      addImage: (data: string, format: string, x: number, y: number, w: number, h: number) => void;
      addPage: () => void;
      save: (name: string) => void;
    };
  },
): Promise<void> {
  const captureCanvas =
    deps?.captureCanvas ??
    (async (el: HTMLElement) => {
      const html2canvas = (await import("html2canvas")).default;
      return html2canvas(el, { scale: 2, useCORS: true, logging: false });
    });

  const canvas = await captureCanvas(element);
  const pdf = deps?.createPdf
    ? deps.createPdf()
    : await (async () => {
        const { jsPDF } = await import("jspdf");
        return new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      })();

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();

  const imgWidth = pageWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  const imgData = canvas.toDataURL("image/png");

  if (imgHeight <= pageHeight) {
    pdf.addImage(imgData, "PNG", 0, 0, imgWidth, imgHeight);
  } else {
    // Slice the tall canvas across multiple pages so charts/tables aren't
    // truncated — each page renders the same full-width image shifted up by
    // one page's worth of height.
    let remainingHeight = imgHeight;
    let position = 0;
    let firstPage = true;

    while (remainingHeight > 0) {
      if (!firstPage) pdf.addPage();
      pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
      remainingHeight -= pageHeight;
      position -= pageHeight;
      firstPage = false;
    }
  }

  pdf.save(filename);
}
