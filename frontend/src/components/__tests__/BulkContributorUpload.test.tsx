import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, beforeEach, test, expect, vi } from "vitest";
import { BulkContributorUpload } from "../BulkContributorUpload";
import { api } from "../../api";

vi.mock("../../api");

const mockApi = api as any;
const CONTRACT_ID = "CAFQE4X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7";

describe("BulkContributorUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.previewCsv = vi.fn();
    mockApi.importCsv = vi.fn();
    mockApi.downloadCsvTemplate = vi.fn();
  });

  test("renders upload dropzone", () => {
    render(<BulkContributorUpload contractId={CONTRACT_ID} />);
    expect(screen.getByText(/Drag and drop a CSV file here/i)).toBeDefined();
    expect(screen.getByText(/Download CSV Template/i)).toBeDefined();
  });

  test("shows error for non-CSV file", () => {
    render(<BulkContributorUpload contractId={CONTRACT_ID} />);
    const file = new File(["test"], "test.txt", { type: "text/plain" });
    const input = screen.getByLabelText(/upload csv file/i) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText(/Please select a CSV file/i)).toBeDefined();
  });

  test("displays valid preview data", async () => {
    const previewData = {
      success: true,
      data: {
        importId: null,
        fileName: "test.csv",
        totalRows: 2,
        validRows: [
          { rowIndex: 1, address: "GABCDEF1234567890XYZ", share: 50 },
          { rowIndex: 2, address: "G1234567890ABCDEFXYZ", share: 50 },
        ],
        errorRows: [],
        summary: { total: 2, valid: 2, errors: 0 },
      },
    };
    mockApi.previewCsv.mockResolvedValue(previewData);

    render(<BulkContributorUpload contractId={CONTRACT_ID} />);
    const input = screen.getByLabelText(/upload csv file/i) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["address,share_percentage"], "test.csv", { type: "text/csv" })] },
    });

    await waitFor(() => {
      expect(screen.getByText(/2 valid rows/)).toBeDefined();
    });
  });

  test("displays errors when CSV has invalid rows", async () => {
    const previewData = {
      success: true,
      data: {
        importId: null,
        fileName: "test.csv",
        totalRows: 2,
        validRows: [],
        errorRows: [
          {
            rowIndex: 1,
            address: "invalid",
            share: "50",
            error: "Invalid Stellar address",
          },
        ],
        summary: { total: 1, valid: 0, errors: 1 },
      },
    };
    mockApi.previewCsv.mockResolvedValue(previewData);

    render(<BulkContributorUpload contractId={CONTRACT_ID} />);
    const input = screen.getByLabelText(/upload csv file/i) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["address,share_percentage"], "test.csv", { type: "text/csv" })] },
    });

    await waitFor(() => {
      expect(screen.getByText(/1 errors/)).toBeDefined();
    });
  });

  test("handles import success", async () => {
    const previewData = {
      success: true,
      data: {
        importId: null,
        fileName: "test.csv",
        totalRows: 2,
        validRows: [
          { rowIndex: 1, address: "GABCDEF1234567890XYZ", share: 50 },
        ],
        errorRows: [],
        summary: { total: 1, valid: 1, errors: 0 },
      },
    };
    mockApi.previewCsv.mockResolvedValue(previewData);

    const importResult = {
      success: true,
      data: {
        importId: 1,
        fileName: "test.csv",
        summary: { total: 1, successCount: 1, errorCount: 0 },
      },
    };
    mockApi.importCsv.mockResolvedValue(importResult);

    render(<BulkContributorUpload contractId={CONTRACT_ID} />);
    const input = screen.getByLabelText(/upload csv file/i) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["address,share_percentage"], "test.csv", { type: "text/csv" })] },
    });

    await waitFor(() => {
      expect(screen.getByText(/1 valid rows/)).toBeDefined();
    });
  });
});
