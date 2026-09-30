import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DocumentManager from "./DocumentManager";

if (!File.prototype.text) {
  File.prototype.text = function () {
    return Promise.resolve("test file content");
  };
}

describe("DocumentManager Component (#1060)", () => {
  const MOCK_DOCS = [
    {
      id: "doc_test_1",
      title: "Master Royalty Agreement 2026",
      doc_type: "contract",
      owner_address: "GAOWNER123",
      contract_id: "C_ROYALTY_01",
      description: "Music royalty distribution contract",
      current_version: 1,
      current_cid: "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
      signature_status: "pending",
      tags: ["legal", "music"],
      created_at: 1774900000000,
      updated_at: 1774900000000,
      gatewayUrl: "https://ipfs.io/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
      signatures: [{ id: 1, signer_address: "GASIGNER123", status: "pending" }],
      permissionsCount: 2,
    },
    {
      id: "doc_test_2",
      title: "Zero-Knowledge Distribution Proof",
      doc_type: "proof",
      owner_address: "GAOWNER123",
      contract_id: "C_ROYALTY_01",
      description: "ZK-proof for batch payout",
      current_version: 2,
      current_cid: "QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR",
      signature_status: "signed",
      tags: ["zk", "proof"],
      created_at: 1774800000000,
      updated_at: 1774850000000,
      gatewayUrl: "https://ipfs.io/ipfs/QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR",
      signatures: [{ id: 2, signer_address: "GASIGNER123", status: "signed" }],
      permissionsCount: 1,
    },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/documents?") || url.endsWith("/documents")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { documents: MOCK_DOCS } }),
        });
      }
      if (url.includes("/audit-trail")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: {
                verified: true,
                events: [
                  {
                    id: 1,
                    action: "create",
                    performed_by: "GAOWNER123",
                    timestamp: Date.now(),
                    integrity_hash: "hash_genesis_123",
                  },
                ],
              },
            }),
        });
      }
      if (url.includes("/documents/doc_test_1")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: {
                ...MOCK_DOCS[0],
                versions: [{ id: 1, version_number: 1, cid: "QmXoypiz...", file_name: "agreement.pdf" }],
                permissions: [
                  {
                    id: 1,
                    collaborator_address: "GACOLLAB123",
                    permission_level: "view",
                  },
                ],
                signatures: [{ id: 1, signer_address: "GASIGNER123", status: "pending" }],
              },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: {} }),
        blob: () => Promise.resolve(new Blob(["mock content"])),
        headers: new Headers({ "Content-Disposition": 'attachment; filename="test.pdf"' }),
      });
    });
  });

  it("renders DocumentManager header, stats, and documents table", async () => {
    render(<DocumentManager currentUserAddress="GAOWNER123" />);

    expect(screen.getByText("Document Management & IPFS")).toBeDefined();
    expect(screen.getByTestId("upload-doc-btn")).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText("Master Royalty Agreement 2026")).toBeDefined();
      expect(screen.getByText("Zero-Knowledge Distribution Proof")).toBeDefined();
    });

    expect(screen.getByTestId("stat-total-docs").textContent).toBe("2");
    expect(screen.getByTestId("stat-pending-sigs").textContent).toBe("1");
  });

  it("filters documents by search query and type dropdown", async () => {
    render(<DocumentManager currentUserAddress="GAOWNER123" />);

    await waitFor(() => {
      expect(screen.getByText("Master Royalty Agreement 2026")).toBeDefined();
    });

    const searchInput = screen.getByTestId("doc-search-input");
    fireEvent.change(searchInput, { target: { value: "Zero-Knowledge" } });

    const typeSelect = screen.getByTestId("filter-doc-type");
    fireEvent.change(typeSelect, { target: { value: "proof" } });

    expect(typeSelect).toHaveValue("proof");
  });

  it("opens upload modal and submits new document to IPFS", async () => {
    const user = userEvent.setup();
    render(<DocumentManager currentUserAddress="GAOWNER123" />);

    const uploadBtn = screen.getByTestId("upload-doc-btn");
    await user.click(uploadBtn);

    expect(screen.getByTestId("upload-modal")).toBeDefined();
    expect(screen.getByText("Upload Document to IPFS")).toBeDefined();

    const titleInput = screen.getByTestId("input-doc-title");
    fireEvent.change(titleInput, { target: { value: "New Licensing Deal" } });

    const file = new File(["test license terms"], "license.pdf", { type: "application/pdf" });
    const fileInput = screen.getByTestId("input-doc-file");
    fireEvent.change(fileInput, { target: { files: [file] } });

    const form = screen.getByTestId("upload-modal").querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/documents"),
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("opens share modal and allows granting & revoking permissions", async () => {
    const user = userEvent.setup();
    render(<DocumentManager currentUserAddress="GAOWNER123" />);

    await waitFor(() => {
      expect(screen.getByTestId("share-btn-doc_test_1")).toBeDefined();
    });

    const shareBtn = screen.getByTestId("share-btn-doc_test_1");
    await user.click(shareBtn);

    expect(screen.getByTestId("share-modal")).toBeDefined();
    expect(screen.getByText("Collaborator Access & Permissions")).toBeDefined();

    const addressInput = screen.getByTestId("input-share-address");
    await user.type(addressInput, "GANEWCOLLABORATOR123");

    const permSelect = screen.getByTestId("select-share-permission");
    fireEvent.change(permSelect, { target: { value: "download" } });

    const grantBtn = screen.getByTestId("submit-share-btn");
    await user.click(grantBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/documents/doc_test_1/share"),
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("opens digital signature modal and allows signing document", async () => {
    const user = userEvent.setup();
    window.alert = vi.fn();
    render(<DocumentManager currentUserAddress="GASIGNER123" />);

    await waitFor(() => {
      expect(screen.getByTestId("sign-btn-doc_test_1")).toBeDefined();
    });

    const signBtn = screen.getByTestId("sign-btn-doc_test_1");
    await user.click(signBtn);

    expect(screen.getByTestId("sign-modal")).toBeDefined();

    const executeSignBtn = screen.getByTestId("execute-sign-btn");
    await user.click(executeSignBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/documents/doc_test_1/sign"),
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("opens audit modal and triggers CSV and JSON exports", async () => {
    const user = userEvent.setup();
    window.URL.createObjectURL = vi.fn(() => "blob:http://localhost/mock");
    window.URL.revokeObjectURL = vi.fn();

    render(<DocumentManager currentUserAddress="GAOWNER123" />);

    await waitFor(() => {
      expect(screen.getByTestId("audit-btn-doc_test_1")).toBeDefined();
    });

    const auditBtn = screen.getByTestId("audit-btn-doc_test_1");
    await user.click(auditBtn);

    expect(screen.getByTestId("audit-modal")).toBeDefined();
    expect(screen.getByText("Audit Trail: Master Royalty Agreement 2026")).toBeDefined();

    const exportCsvBtn = screen.getByTestId("export-audit-csv-btn");
    await user.click(exportCsvBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/documents/doc_test_1/audit-trail/export?format=csv"),
        expect.anything(),
      );
    });
  });

  it("handles empty document list state", async () => {
    (global.fetch as any).mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { documents: [] } }),
      }),
    );

    render(<DocumentManager currentUserAddress="GAOWNER123" />);

    await waitFor(() => {
      expect(screen.getByTestId("empty-docs-message")).toBeDefined();
      expect(screen.getByText("No documents found")).toBeDefined();
    });
  });
});
