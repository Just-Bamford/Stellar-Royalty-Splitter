import React, { useReducer, useMemo, useEffect, useCallback } from "react";
import "./DocumentManager.css";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const FILE_SIZE_ERROR = "File too large. Maximum size is 5 MB.";

export type DocumentType =
  | "contract"
  | "agreement"
  | "proof"
  | "tax_form"
  | "amendment"
  | "other";

export type PermissionLevel = "view" | "download" | "sign" | "admin";

export type SignatureStatus =
  | "unsigned"
  | "pending"
  | "partially_signed"
  | "signed"
  | "rejected";

export interface DocumentVersion {
  id: number;
  document_id: string;
  version_number: number;
  cid: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  checksum: string;
  created_by: string;
  change_summary?: string;
  created_at: number;
}

export interface DocumentPermission {
  id: number;
  document_id: string;
  collaborator_address: string;
  permission_level: PermissionLevel;
  granted_by: string;
  granted_at: number;
  expires_at?: number | null;
}

export interface DocumentSignature {
  id: number;
  document_id: string;
  version_number: number;
  signer_address: string;
  status: "pending" | "signed" | "rejected";
  signature?: string | null;
  signed_at?: number | null;
  rejection_reason?: string | null;
}

export interface DocumentItem {
  id: string;
  title: string;
  doc_type: DocumentType;
  owner_address: string;
  contract_id?: string | null;
  description?: string;
  current_version: number;
  current_cid: string;
  signature_status: SignatureStatus;
  tags?: string[];
  created_at: number;
  updated_at: number;
  gatewayUrl?: string;
  signatures?: DocumentSignature[];
  permissionsCount?: number;
}

export interface AuditEvent {
  id: number;
  document_id: string;
  version_number?: number | null;
  action: string;
  performed_by: string;
  details: Record<string, any>;
  previous_hash: string;
  integrity_hash: string;
  timestamp: number;
}

export interface DocumentManagerProps {
  currentUserAddress?: string;
  contractId?: string;
  apiBaseUrl?: string;
  onDocumentSelected?: (doc: DocumentItem) => void;
}

interface DocManagerState {
  catalog: {
    documents: DocumentItem[];
    loading: boolean;
    error: string | null;
  };
  filters: {
    searchQuery: string;
    typeFilter: string;
    statusFilter: string;
    startDate: string;
    endDate: string;
    collaboratorFilter: string;
  };
  dialogs: {
    showUploadModal: boolean;
    showVersionModal: boolean;
    showShareModal: boolean;
    showSignModal: boolean;
    showAuditModal: boolean;
    selectedDoc: DocumentItem | null;
    permissionsList: DocumentPermission[];
    signatureList: DocumentSignature[];
    uploading: boolean;
  };
  uploadForm: {
    uploadTitle: string;
    uploadType: DocumentType;
    uploadDesc: string;
    uploadTags: string;
    uploadSigners: string;
    uploadFile: File | null;
    uploadFileError: string | null;
    uploadPin: boolean;
  };
  versionForm: {
    versionSummary: string;
    versionFile: File | null;
    versionSigners: string;
  };
  shareForm: {
    shareAddress: string;
    sharePermission: PermissionLevel;
  };
  signatureForm: {
    rejectionReason: string;
  };
  audit: {
    auditEvents: AuditEvent[];
    auditVerified: boolean;
  };
}

const initialState: DocManagerState = {
  catalog: { documents: [], loading: true, error: null },
  filters: {
    searchQuery: "",
    typeFilter: "all",
    statusFilter: "all",
    startDate: "",
    endDate: "",
    collaboratorFilter: "",
  },
  dialogs: {
    showUploadModal: false,
    showVersionModal: false,
    showShareModal: false,
    showSignModal: false,
    showAuditModal: false,
    selectedDoc: null,
    permissionsList: [],
    signatureList: [],
    uploading: false,
  },
  uploadForm: {
    uploadTitle: "",
    uploadType: "contract",
    uploadDesc: "",
    uploadTags: "",
    uploadSigners: "",
    uploadFile: null,
    uploadFileError: null,
    uploadPin: true,
  },
  versionForm: { versionSummary: "", versionFile: null, versionSigners: "" },
  shareForm: { shareAddress: "", sharePermission: "view" },
  signatureForm: { rejectionReason: "" },
  audit: { auditEvents: [], auditVerified: true },
};

type DocManagerAction = {
  [Group in keyof DocManagerState]: { group: Group; changes: Partial<DocManagerState[Group]> };
}[keyof DocManagerState];

function docManagerReducer(state: DocManagerState, { group, changes }: DocManagerAction): DocManagerState {
  return { ...state, [group]: { ...state[group], ...changes } };
}

type DocumentDialog = "showVersionModal" | "showShareModal" | "showSignModal" | "showAuditModal";

export const DocumentManager: React.FC<DocumentManagerProps> = ({
  currentUserAddress = "GADMIN...CONTRACT",
  contractId,
  apiBaseUrl = "/api/v1",
  onDocumentSelected,
}) => {
  const [state, dispatch] = useReducer(docManagerReducer, initialState);
  const { documents, loading, error } = state.catalog;
  const { searchQuery, typeFilter, statusFilter, startDate, endDate, collaboratorFilter } = state.filters;
  const {
    showUploadModal, showVersionModal, showShareModal, showSignModal, showAuditModal,
    selectedDoc, permissionsList, signatureList, uploading,
  } = state.dialogs;
  const {
    uploadTitle, uploadType, uploadDesc, uploadTags, uploadSigners, uploadFile, uploadFileError, uploadPin,
  } = state.uploadForm;

  const closeUploadDialog = () => {
    dispatch({ group: "dialogs", changes: { showUploadModal: false } });
    dispatch({ group: "uploadForm", changes: { uploadFile: null, uploadFileError: null } });
  };
  const { versionSummary, versionFile, versionSigners } = state.versionForm;
  const { shareAddress, sharePermission } = state.shareForm;
  const { rejectionReason } = state.signatureForm;
  const { auditEvents, auditVerified } = state.audit;

  const openDocumentDialog = useCallback(
    (doc: DocumentItem, dialog: DocumentDialog) => {
      dispatch({ group: "dialogs", changes: { selectedDoc: doc, [dialog]: true } });
      onDocumentSelected?.(doc);
    },
    [onDocumentSelected]
  );

  // Load documents
  const fetchDocuments = useCallback(async () => {
    try {
      dispatch({ group: "catalog", changes: { loading: true, error: null } });
      const params = new URLSearchParams();
      if (searchQuery) params.append("query", searchQuery);
      if (typeFilter !== "all") params.append("docType", typeFilter);
      if (statusFilter !== "all") params.append("signatureStatus", statusFilter);
      if (startDate) params.append("startDate", startDate);
      if (endDate) params.append("endDate", endDate);
      if (collaboratorFilter) params.append("collaborator", collaboratorFilter);
      if (contractId) params.append("contractId", contractId);

      const res = await fetch(`${apiBaseUrl}/documents?${params.toString()}`, {
        headers: { "x-user-id": currentUserAddress },
      });

      if (!res.ok) {
        throw new Error(`Failed to load documents: ${res.statusText}`);
      }

      const json = await res.json();
      if (json.success && json.data) {
        dispatch({ group: "catalog", changes: { documents: json.data.documents || [] } });
      }
    } catch (err: any) {
      dispatch({ group: "catalog", changes: { error: err.message || "Failed to load documents catalog" } });
    } finally {
      dispatch({ group: "catalog", changes: { loading: false } });
    }
  }, [apiBaseUrl, currentUserAddress, searchQuery, typeFilter, statusFilter, startDate, endDate, collaboratorFilter, contractId]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  // Safe file reader supporting both modern File.text() and FileReader
  const readFileContent = async (file: File): Promise<string> => {
    if (typeof (file as any).text === "function") {
      try {
        return await (file as any).text();
      } catch (_e) {
        // Fallback to FileReader
      }
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result?.toString() || "");
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsText(file);
    });
  };

  // Handle Document Creation / Upload
  const handleCreateDocument = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (uploadFileError) return;
    if (!uploadTitle.trim() || !uploadFile) {
      alert("Please provide a document title and file");
      return;
    }

    try {
      dispatch({ group: "dialogs", changes: { uploading: true } });
      const fileContent = await readFileContent(uploadFile);
      const signersArray = uploadSigners
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const tagsArray = uploadTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const payload = {
        title: uploadTitle.trim(),
        docType: uploadType,
        contractId: contractId || null,
        description: uploadDesc.trim(),
        tags: tagsArray,
        fileContent,
        fileName: uploadFile.name,
        mimeType: uploadFile.type || "application/octet-stream",
        signers: signersArray,
        ownerAddress: currentUserAddress,
        pinToIpfs: uploadPin,
      };

      const res = await fetch(`${apiBaseUrl}/documents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": currentUserAddress,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Document upload failed");
      }

      dispatch({ group: "dialogs", changes: { showUploadModal: false } });
      dispatch({ group: "uploadForm", changes: initialState.uploadForm });
      fetchDocuments();
    } catch (err: any) {
      alert(`Error uploading document: ${err.message}`);
    } finally {
      dispatch({ group: "dialogs", changes: { uploading: false } });
    }
  }, [uploadTitle, uploadFile, uploadFileError, uploadSigners, uploadTags, uploadType, contractId, uploadDesc, currentUserAddress, uploadPin, apiBaseUrl, fetchDocuments]);

  // Handle Uploading a New Version
  const handleUploadNewVersion = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDoc || !versionFile) {
      alert("Please select a file for the new version");
      return;
    }

    try {
      dispatch({ group: "dialogs", changes: { uploading: true } });
      const fileContent = await readFileContent(versionFile);
      const signersArray = versionSigners
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const payload = {
        fileContent,
        fileName: versionFile.name,
        mimeType: versionFile.type || "application/octet-stream",
        createdBy: currentUserAddress,
        changeSummary: versionSummary.trim() || `Version update`,
        signers: signersArray,
      };

      const res = await fetch(`${apiBaseUrl}/documents/${selectedDoc.id}/versions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": currentUserAddress,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Version upload failed");
      }

      dispatch({ group: "dialogs", changes: { showVersionModal: false } });
      dispatch({ group: "versionForm", changes: initialState.versionForm });
      fetchDocuments();
    } catch (err: any) {
      alert(`Error creating version: ${err.message}`);
    } finally {
      dispatch({ group: "dialogs", changes: { uploading: false } });
    }
  }, [selectedDoc, versionFile, versionSigners, currentUserAddress, versionSummary, apiBaseUrl, fetchDocuments]);

  // Load Single Document Detailed Data for Modals
  const loadDocumentDetails = useCallback(async (docId: string) => {
    try {
      const res = await fetch(`${apiBaseUrl}/documents/${docId}`, {
        headers: { "x-user-id": currentUserAddress },
      });
      if (res.ok) {
        const json = await res.json();
        if (json.data) {
          dispatch({
            group: "dialogs",
            changes: {
              selectedDoc: json.data,
              permissionsList: json.data.permissions || [],
              signatureList: json.data.signatures || [],
            },
          });
        }
      }
    } catch (_err) {
      // Ignore
    }
  }, [apiBaseUrl, currentUserAddress]);

  // Handle Document Download (with view-only vs download enforcement)
  const handleDownload = useCallback(async (doc: DocumentItem, version?: number) => {
    try {
      const url = `${apiBaseUrl}/documents/${doc.id}/download${version ? `?version=${version}` : ""}`;
      const res = await fetch(url, {
        headers: { "x-user-id": currentUserAddress },
      });

      if (res.status === 403) {
        alert("Access Denied: You have view-only permissions for this document. Download is restricted.");
        return;
      }

      if (!res.ok) {
        throw new Error(`Download failed (${res.status}): ${res.statusText}`);
      }

      const blob = await res.blob();
      const contentDisposition = res.headers.get("Content-Disposition");
      let filename = `${doc.title}.pdf`;
      if (contentDisposition && contentDisposition.includes("filename=")) {
        filename = contentDisposition.split("filename=")[1].replace(/"/g, "");
      }

      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(downloadUrl);
      document.body.removeChild(a);
    } catch (err: any) {
      alert(`Download error: ${err.message}`);
    }
  }, [apiBaseUrl, currentUserAddress]);

  // Handle Share / Grant Permission
  const handleShare = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDoc || !shareAddress.trim()) return;

    try {
      const res = await fetch(`${apiBaseUrl}/documents/${selectedDoc.id}/share`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": currentUserAddress,
        },
        body: JSON.stringify({
          collaboratorAddress: shareAddress.trim(),
          permissionLevel: sharePermission,
          grantedBy: currentUserAddress,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Sharing failed");
      }

      dispatch({ group: "shareForm", changes: { shareAddress: "" } });
      loadDocumentDetails(selectedDoc.id);
    } catch (err: any) {
      alert(`Share error: ${err.message}`);
    }
  }, [selectedDoc, shareAddress, apiBaseUrl, currentUserAddress, sharePermission, loadDocumentDetails]);

  // Revoke Permission
  const handleRevoke = useCallback(async (collaboratorAddress: string) => {
    if (!selectedDoc) return;
    try {
      const res = await fetch(
        `${apiBaseUrl}/documents/${selectedDoc.id}/share/${collaboratorAddress}?revokedBy=${currentUserAddress}`,
        {
          method: "DELETE",
          headers: { "x-user-id": currentUserAddress },
        },
      );
      if (!res.ok) {
        throw new Error("Failed to revoke access");
      }
      loadDocumentDetails(selectedDoc.id);
    } catch (err: any) {
      alert(`Revoke error: ${err.message}`);
    }
  }, [selectedDoc, apiBaseUrl, currentUserAddress, loadDocumentDetails]);

  // Digital Signature
  const handleSign = useCallback(async () => {
    if (!selectedDoc) return;
    try {
      const simulatedSignature = `sig_ed25519_${Date.now()}_${currentUserAddress.slice(0, 8)}`;
      const res = await fetch(`${apiBaseUrl}/documents/${selectedDoc.id}/sign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": currentUserAddress,
        },
        body: JSON.stringify({
          signerAddress: currentUserAddress,
          signature: simulatedSignature,
          metadata: { signedVia: "Stellar Royalty Splitter UI" },
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Signing failed");
      }

      loadDocumentDetails(selectedDoc.id);
      fetchDocuments();
      alert("Document signed successfully!");
    } catch (err: any) {
      alert(`Signature error: ${err.message}`);
    }
  }, [selectedDoc, currentUserAddress, apiBaseUrl, loadDocumentDetails, fetchDocuments]);

  // Reject Signature
  const handleRejectSignature = useCallback(async () => {
    if (!selectedDoc) return;
    try {
      const res = await fetch(`${apiBaseUrl}/documents/${selectedDoc.id}/reject`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": currentUserAddress,
        },
        body: JSON.stringify({
          signerAddress: currentUserAddress,
          reason: rejectionReason || "Rejected by collaborator",
        }),
      });

      if (!res.ok) {
        throw new Error("Reject failed");
      }

      dispatch({ group: "signatureForm", changes: { rejectionReason: "" } });
      loadDocumentDetails(selectedDoc.id);
      fetchDocuments();
      alert("Signature request rejected.");
    } catch (err: any) {
      alert(`Reject error: ${err.message}`);
    }
  }, [selectedDoc, apiBaseUrl, currentUserAddress, rejectionReason, loadDocumentDetails, fetchDocuments]);

  // Open Audit Trail
  const handleOpenAudit = useCallback(async (doc: DocumentItem) => {
    openDocumentDialog(doc, "showAuditModal");
    try {
      const res = await fetch(`${apiBaseUrl}/documents/${doc.id}/audit-trail`, {
        headers: { "x-user-id": currentUserAddress },
      });
      if (res.ok) {
        const json = await res.json();
        dispatch({
          group: "audit",
          changes: { auditEvents: json.data.events || [], auditVerified: json.data.verified !== false },
        });
      }
    } catch (_err) {
      dispatch({ group: "audit", changes: { auditEvents: [] } });
    }
  }, [openDocumentDialog, apiBaseUrl, currentUserAddress]);

  // Export Audit Trail
  const handleExportAudit = useCallback(async (format: "csv" | "json") => {
    if (!selectedDoc) return;
    try {
      const url = `${apiBaseUrl}/documents/${selectedDoc.id}/audit-trail/export?format=${format}`;
      const res = await fetch(url, {
        headers: { "x-user-id": currentUserAddress },
      });

      if (!res.ok) throw new Error("Export failed");

      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `audit-trail-${selectedDoc.id}.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(downloadUrl);
      document.body.removeChild(a);
    } catch (err: any) {
      alert(`Export error: ${err.message}`);
    }
  }, [selectedDoc, apiBaseUrl, currentUserAddress]);

  // Stats calculation
  const stats = useMemo(() => {
    const total = documents.length;
    const pendingSignatures = documents.filter((d) => d.signature_status === "pending" || d.signature_status === "partially_signed").length;
    const signedCount = documents.filter((d) => d.signature_status === "signed").length;
    const contractsCount = documents.filter((d) => d.doc_type === "contract").length;
    return { total, pendingSignatures, signedCount, contractsCount };
  }, [documents]);

  return (
    <div className="doc-manager-container" data-testid="document-manager">
      {/* Header */}
      <header className="doc-manager-header">
        <div className="doc-manager-title-group">
          <h2>Document Management &amp; IPFS</h2>
          <p className="doc-manager-subtitle">
            Decentralized, immutable storage with versioning, access control, digital signatures, and audit trails.
          </p>
        </div>
        <div className="doc-manager-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={fetchDocuments}
            title="Refresh documents list"
          >
            &#x21bb; Refresh
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => dispatch({ group: "dialogs", changes: { showUploadModal: true } })}
            data-testid="upload-doc-btn"
          >
            + Upload Document
          </button>
        </div>
      </header>

      {/* Stats Cards */}
      <div className="doc-stats-grid">
        <div className="doc-stat-card">
          <span className="doc-stat-label">Total Documents</span>
          <span className="doc-stat-value" data-testid="stat-total-docs">{stats.total}</span>
        </div>
        <div className="doc-stat-card">
          <span className="doc-stat-label">Pending Signatures</span>
          <span className="doc-stat-value text-amber-600" data-testid="stat-pending-sigs">{stats.pendingSignatures}</span>
        </div>
        <div className="doc-stat-card">
          <span className="doc-stat-label">Fully Signed</span>
          <span className="doc-stat-value text-green-600">{stats.signedCount}</span>
        </div>
        <div className="doc-stat-card">
          <span className="doc-stat-label">Smart Contracts</span>
          <span className="doc-stat-value">{stats.contractsCount}</span>
        </div>
      </div>

      {/* Filters & Search */}
      <section className="doc-filters-panel" aria-label="Document search and filters">
        <div className="doc-search-row">
          <div className="doc-search-input-wrap">
            <span className="doc-search-icon">&#128269;</span>
            <input
              type="text"
              className="doc-search-input"
              placeholder="Search by title, description, CID, tags, or ID..."
              value={searchQuery}
              onChange={(e) => dispatch({ group: "filters", changes: { searchQuery: e.target.value } })}
              aria-label="Search documents"
              data-testid="doc-search-input"
            />
          </div>

          <div className="doc-filter-group">
            <select
              className="doc-select"
              value={typeFilter}
              onChange={(e) => dispatch({ group: "filters", changes: { typeFilter: e.target.value } })}
              aria-label="Filter by document type"
              data-testid="filter-doc-type"
            >
              <option value="all">All Types</option>
              <option value="contract">Contracts</option>
              <option value="agreement">Agreements</option>
              <option value="proof">Proofs</option>
              <option value="tax_form">Tax Forms</option>
              <option value="amendment">Amendments</option>
              <option value="other">Other</option>
            </select>

            <select
              className="doc-select"
              value={statusFilter}
              onChange={(e) => dispatch({ group: "filters", changes: { statusFilter: e.target.value } })}
              aria-label="Filter by signature status"
              data-testid="filter-sig-status"
            >
              <option value="all">All Statuses</option>
              <option value="unsigned">Unsigned</option>
              <option value="pending">Pending Signature</option>
              <option value="partially_signed">Partially Signed</option>
              <option value="signed">Fully Signed</option>
              <option value="rejected">Rejected</option>
            </select>

            <input
              type="date"
              className="doc-date-input"
              value={startDate}
              onChange={(e) => dispatch({ group: "filters", changes: { startDate: e.target.value } })}
              title="Start Date"
              aria-label="Start date filter"
            />
            <input
              type="date"
              className="doc-date-input"
              value={endDate}
              onChange={(e) => dispatch({ group: "filters", changes: { endDate: e.target.value } })}
              title="End Date"
              aria-label="End date filter"
            />

            {(searchQuery || typeFilter !== "all" || statusFilter !== "all" || startDate || endDate || collaboratorFilter) && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => dispatch({ group: "filters", changes: initialState.filters })}
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Error Message */}
      {error && <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded-md" role="alert">{error}</div>}

      {/* Document Table */}
      <section className="doc-table-wrapper" aria-label="Documents Catalog">
        {loading ? (
          <div className="doc-empty-state">Loading documents...</div>
        ) : documents.length === 0 ? (
          <div className="doc-empty-state" data-testid="empty-docs-message">
            <div className="doc-empty-icon">&#128196;</div>
            <h3>No documents found</h3>
            <p>Upload a contract, agreement, or proof to store it immutably on IPFS.</p>
          </div>
        ) : (
          <table className="doc-table" data-testid="documents-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Type</th>
                <th>Version</th>
                <th>IPFS CID</th>
                <th>Signature Status</th>
                <th>Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} data-testid={`doc-row-${doc.id}`}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{doc.title}</div>
                    {doc.description && (
                      <div style={{ fontSize: "0.8rem", color: "#64748b" }}>{doc.description}</div>
                    )}
                    {doc.tags && doc.tags.length > 0 && (
                      <div>
                        {doc.tags.map((t) => (
                          <span key={t} className="tag-chip">{t}</span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`badge badge-${doc.doc_type}`}>{doc.doc_type.replace("_", " ")}</span>
                  </td>
                  <td>
                    <span className="badge-version">v{doc.current_version}</span>
                  </td>
                  <td>
                    <a
                      href={doc.gatewayUrl || `https://ipfs.io/ipfs/${doc.current_cid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="cid-chip"
                      title="View on IPFS Gateway"
                    >
                      {doc.current_cid.slice(0, 6)}...{doc.current_cid.slice(-4)} &#x2197;
                    </a>
                  </td>
                  <td>
                    <span className={`badge badge-${doc.signature_status}`}>
                      {doc.signature_status === "signed" && "✓ "}
                      {doc.signature_status === "pending" && "⏱ "}
                      {doc.signature_status === "rejected" && "✕ "}
                      {doc.signature_status.replace("_", " ")}
                    </span>
                  </td>
                  <td>
                    <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                      {new Date(doc.updated_at).toLocaleDateString()}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => handleDownload(doc)}
                        title="Download Document"
                        data-testid={`download-btn-${doc.id}`}
                      >
                        Download
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => {
                          openDocumentDialog(doc, "showVersionModal");
                          loadDocumentDetails(doc.id);
                        }}
                        title="New Version"
                        data-testid={`version-btn-${doc.id}`}
                      >
                        + Version
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => {
                          openDocumentDialog(doc, "showShareModal");
                          loadDocumentDetails(doc.id);
                        }}
                        title="Share & Permissions"
                        data-testid={`share-btn-${doc.id}`}
                      >
                        Share
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => {
                          openDocumentDialog(doc, "showSignModal");
                          loadDocumentDetails(doc.id);
                        }}
                        title="Signatures"
                        data-testid={`sign-btn-${doc.id}`}
                      >
                        Sign
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => handleOpenAudit(doc)}
                        title="Audit Trail"
                        data-testid={`audit-btn-${doc.id}`}
                      >
                        Audit
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Upload Document Modal */}
      {showUploadModal && (
        <div className="doc-modal-overlay" role="dialog" aria-modal="true" data-testid="upload-modal">
          <div className="doc-modal">
            <div className="doc-modal-header">
              <h3>Upload Document to IPFS</h3>
              <button
                type="button"
                className="doc-modal-close"
                onClick={closeUploadDialog}
                aria-label="Close modal"
              >
                &times;
              </button>
            </div>
            <form onSubmit={handleCreateDocument}>
              <div className="doc-modal-body">
                <div className="doc-form-group">
                  <label htmlFor="upload-title">Document Title *</label>
                  <input
                    id="upload-title"
                    type="text"
                    className="doc-input"
                    placeholder="e.g. Master Royalty Agreement 2026"
                    value={uploadTitle}
                    onChange={(e) => dispatch({ group: "uploadForm", changes: { uploadTitle: e.target.value } })}
                    required
                    data-testid="input-doc-title"
                  />
                </div>

                <div className="doc-form-group">
                  <label htmlFor="upload-type">Document Type *</label>
                  <select
                    id="upload-type"
                    className="doc-select"
                    value={uploadType}
                    onChange={(e) => dispatch({ group: "uploadForm", changes: { uploadType: e.target.value as DocumentType } })}
                  >
                    <option value="contract">Smart Contract / Terms</option>
                    <option value="agreement">Royalty Split Agreement</option>
                    <option value="proof">Cryptographic / ZK Proof</option>
                    <option value="tax_form">Tax Compliance Form</option>
                    <option value="amendment">Contract Amendment</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div className="doc-form-group">
                  <label htmlFor="upload-desc">Description</label>
                  <textarea
                    id="upload-desc"
                    className="doc-textarea"
                    placeholder="Brief description of the agreement or proof..."
                    value={uploadDesc}
                    onChange={(e) => dispatch({ group: "uploadForm", changes: { uploadDesc: e.target.value } })}
                  />
                </div>

                <div className="doc-form-group">
                  <label htmlFor="upload-tags">Tags (comma-separated)</label>
                  <input
                    id="upload-tags"
                    type="text"
                    className="doc-input"
                    placeholder="e.g. legal, 2026, music, split-v2"
                    value={uploadTags}
                    onChange={(e) => dispatch({ group: "uploadForm", changes: { uploadTags: e.target.value } })}
                  />
                </div>

                <div className="doc-form-group">
                  <label htmlFor="upload-signers">Required Signers (comma-separated Stellar addresses)</label>
                  <input
                    id="upload-signers"
                    type="text"
                    className="doc-input"
                    placeholder="e.g. GB..., GC..."
                    value={uploadSigners}
                    onChange={(e) => dispatch({ group: "uploadForm", changes: { uploadSigners: e.target.value } })}
                    data-testid="input-doc-signers"
                  />
                </div>

                <div className="doc-form-group">
                  <label htmlFor="upload-doc-file">Select Document File *</label>
                  <input
                    id="upload-doc-file"
                    type="file"
                    className="doc-input"
                    aria-invalid={Boolean(uploadFileError)}
                    aria-describedby={uploadFileError ? "upload-doc-file-error" : undefined}
                    onChange={(e) => {
                      const input = e.currentTarget;
                      const file = input.files?.[0] ?? null;
                      const tooLarge = file !== null && file.size > MAX_FILE_SIZE;
                      if (tooLarge) input.value = "";

                      dispatch({
                        group: "uploadForm",
                        changes: {
                          uploadFile: tooLarge ? null : file,
                          uploadFileError: tooLarge ? FILE_SIZE_ERROR : null,
                        },
                      });
                    }}
                    required
                    data-testid="input-doc-file"
                  />
                  {uploadFileError && (
                    <div
                      id="upload-doc-file-error"
                      className="p-3 bg-red-50 text-red-700 border border-red-200 rounded-md"
                      role="alert"
                    >
                      {uploadFileError}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <input
                    type="checkbox"
                    id="pin-ipfs"
                    checked={uploadPin}
                    onChange={(e) => dispatch({ group: "uploadForm", changes: { uploadPin: e.target.checked } })}
                  />
                  <label htmlFor="pin-ipfs" style={{ fontSize: "0.85rem" }}>
                    Pin permanently to IPFS network
                  </label>
                </div>
              </div>

              <div className="doc-modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={closeUploadDialog}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={uploading || Boolean(uploadFileError)}
                  data-testid="submit-upload-btn"
                >
                  {uploading ? "Uploading to IPFS..." : "Upload & Store on IPFS"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Upload New Version Modal */}
      {showVersionModal && selectedDoc && (
        <div className="doc-modal-overlay" role="dialog" aria-modal="true" data-testid="version-modal">
          <div className="doc-modal">
            <div className="doc-modal-header">
              <h3>Upload New Version: {selectedDoc.title} (v{selectedDoc.current_version + 1})</h3>
              <button
                type="button"
                className="doc-modal-close"
                onClick={() => dispatch({ group: "dialogs", changes: { showVersionModal: false } })}
              >
                &times;
              </button>
            </div>
            <form onSubmit={handleUploadNewVersion}>
              <div className="doc-modal-body">
                <div className="doc-form-group">
                  <label htmlFor="version-summary">Change Summary *</label>
                  <input
                    id="version-summary"
                    type="text"
                    className="doc-input"
                    placeholder="e.g. Updated revenue split allocation to 60/40"
                    value={versionSummary}
                    onChange={(e) => dispatch({ group: "versionForm", changes: { versionSummary: e.target.value } })}
                    required
                    data-testid="input-version-summary"
                  />
                </div>

                <div className="doc-form-group">
                  <label htmlFor="version-signers">New Required Signers (optional)</label>
                  <input
                    id="version-signers"
                    type="text"
                    className="doc-input"
                    placeholder="e.g. GB..., GC..."
                    value={versionSigners}
                    onChange={(e) => dispatch({ group: "versionForm", changes: { versionSigners: e.target.value } })}
                  />
                </div>

                <div className="doc-form-group">
                  <label>Updated File *</label>
                  <input
                    type="file"
                    className="doc-input"
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        dispatch({ group: "versionForm", changes: { versionFile: e.target.files[0] } });
                      }
                    }}
                    required
                    data-testid="input-version-file"
                  />
                </div>
              </div>

              <div className="doc-modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => dispatch({ group: "dialogs", changes: { showVersionModal: false } })}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={uploading}
                  data-testid="submit-version-btn"
                >
                  {uploading ? "Publishing Version..." : "Publish Version"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Share / Access Control Modal */}
      {showShareModal && selectedDoc && (
        <div className="doc-modal-overlay" role="dialog" aria-modal="true" data-testid="share-modal">
          <div className="doc-modal">
            <div className="doc-modal-header">
              <h3>Collaborator Access &amp; Permissions</h3>
              <button
                type="button"
                className="doc-modal-close"
                onClick={() => dispatch({ group: "dialogs", changes: { showShareModal: false } })}
              >
                &times;
              </button>
            </div>
            <div className="doc-modal-body">
              <div>
                <h4>Grant Access to Collaborator</h4>
                <form onSubmit={handleShare} style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                  <input
                    type="text"
                    className="doc-input"
                    style={{ flex: 1 }}
                    placeholder="Stellar Wallet Address (G...)"
                    value={shareAddress}
                    onChange={(e) => dispatch({ group: "shareForm", changes: { shareAddress: e.target.value } })}
                    required
                    data-testid="input-share-address"
                  />
                  <select
                    className="doc-select"
                    value={sharePermission}
                    onChange={(e) => dispatch({ group: "shareForm", changes: { sharePermission: e.target.value as PermissionLevel } })}
                    data-testid="select-share-permission"
                  >
                    <option value="view">View Only</option>
                    <option value="download">Download</option>
                    <option value="sign">Signer</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button type="submit" className="btn-primary" data-testid="submit-share-btn">
                    Grant
                  </button>
                </form>
              </div>

              <div style={{ marginTop: "16px" }}>
                <h4>Current Collaborator Permissions</h4>
                {permissionsList.length === 0 ? (
                  <p style={{ fontSize: "0.85rem", color: "#64748b" }}>
                    No collaborator permissions granted yet. Only document owner has access.
                  </p>
                ) : (
                  <ul style={{ listStyle: "none", padding: 0, marginTop: "8px" }}>
                    {permissionsList.map((perm) => (
                      <li
                        key={perm.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "8px 12px",
                          borderBottom: "1px solid #e2e8f0",
                          fontSize: "0.85rem",
                        }}
                      >
                        <div>
                          <span style={{ fontFamily: "monospace", fontWeight: 600 }}>
                            {perm.collaborator_address.slice(0, 8)}...{perm.collaborator_address.slice(-6)}
                          </span>
                          <span className={`badge badge-${perm.permission_level}`} style={{ marginLeft: "8px" }}>
                            {perm.permission_level}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn-danger btn-sm"
                          onClick={() => handleRevoke(perm.collaborator_address)}
                          data-testid={`revoke-btn-${perm.collaborator_address}`}
                        >
                          Revoke
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="doc-modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => dispatch({ group: "dialogs", changes: { showShareModal: false } })}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Digital Signatures Modal */}
      {showSignModal && selectedDoc && (
        <div className="doc-modal-overlay" role="dialog" aria-modal="true" data-testid="sign-modal">
          <div className="doc-modal">
            <div className="doc-modal-header">
              <h3>Digital Signatures: {selectedDoc.title}</h3>
              <button
                type="button"
                className="doc-modal-close"
                onClick={() => dispatch({ group: "dialogs", changes: { showSignModal: false } })}
              >
                &times;
              </button>
            </div>
            <div className="doc-modal-body">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Overall Status:</span>
                <span className={`badge badge-${selectedDoc.signature_status}`}>
                  {selectedDoc.signature_status.replace("_", " ")}
                </span>
              </div>

              <div style={{ marginTop: "16px" }}>
                <h4>Required Signers</h4>
                {signatureList.length === 0 ? (
                  <p style={{ fontSize: "0.85rem", color: "#64748b" }}>
                    No specific signers required for this document.
                  </p>
                ) : (
                  <ul style={{ listStyle: "none", padding: 0, marginTop: "8px" }}>
                    {signatureList.map((sig) => (
                      <li
                        key={sig.id}
                        style={{
                          padding: "10px",
                          border: "1px solid #e2e8f0",
                          borderRadius: "6px",
                          marginBottom: "8px",
                          fontSize: "0.85rem",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontFamily: "monospace" }}>
                            {sig.signer_address.slice(0, 10)}...{sig.signer_address.slice(-6)}
                          </span>
                          <span className={`badge badge-${sig.status}`}>{sig.status}</span>
                        </div>
                        {sig.signature && (
                          <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "4px" }}>
                            Sig: {sig.signature.slice(0, 20)}...
                          </div>
                        )}
                        {sig.signed_at && (
                          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                            Signed on {new Date(sig.signed_at).toLocaleString()}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Sign Action */}
              <div style={{ marginTop: "16px", padding: "16px", background: "#f8fafc", borderRadius: "8px" }}>
                <h4>Sign with Active Wallet ({currentUserAddress.slice(0, 8)}...)</h4>
                <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleSign}
                    data-testid="execute-sign-btn"
                  >
                    Digitally Sign Document
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={handleRejectSignature}
                    data-testid="execute-reject-btn"
                  >
                    Reject
                  </button>
                </div>
              </div>
            </div>
            <div className="doc-modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => dispatch({ group: "dialogs", changes: { showSignModal: false } })}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Audit Trail Modal */}
      {showAuditModal && selectedDoc && (
        <div className="doc-modal-overlay" role="dialog" aria-modal="true" data-testid="audit-modal">
          <div className="doc-modal" style={{ maxWidth: "750px" }}>
            <div className="doc-modal-header">
              <div>
                <h3>Audit Trail: {selectedDoc.title}</h3>
                <div style={{ fontSize: "0.8rem", color: auditVerified ? "#16a34a" : "#dc2626" }}>
                  {auditVerified ? "✓ Hash Chain Verified & Immutable" : "⚠ Verification Alert"}
                </div>
              </div>
              <button
                type="button"
                className="doc-modal-close"
                onClick={() => dispatch({ group: "dialogs", changes: { showAuditModal: false } })}
              >
                &times;
              </button>
            </div>
            <div className="doc-modal-body">
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => handleExportAudit("csv")}
                  data-testid="export-audit-csv-btn"
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => handleExportAudit("json")}
                  data-testid="export-audit-json-btn"
                >
                  Export JSON
                </button>
              </div>

              <div className="audit-timeline" style={{ marginTop: "16px" }}>
                {auditEvents.length === 0 ? (
                  <p>No audit events recorded.</p>
                ) : (
                  auditEvents.map((evt) => (
                    <div key={evt.id} className="audit-item">
                      <div className="audit-dot" />
                      <div className="audit-content">
                        <div className="audit-header">
                          <span className="audit-action">{evt.action.replace("_", " ")}</span>
                          <span className="audit-time">{new Date(evt.timestamp).toLocaleString()}</span>
                        </div>
                        <div className="audit-actor">Actor: {evt.performed_by}</div>
                        {evt.version_number && (
                          <div style={{ fontSize: "0.8rem", color: "#2563eb" }}>Version: v{evt.version_number}</div>
                        )}
                        <div className="audit-hash">Hash: {evt.integrity_hash}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="doc-modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => dispatch({ group: "dialogs", changes: { showAuditModal: false } })}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DocumentManager;