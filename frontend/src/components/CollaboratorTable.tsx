import { useEffect, useState } from "react";
import { api } from "../api";

interface Collaborator {
  address: string;
  basisPoints: number;
}

interface Props {
  contractId: string;
  refreshKey: number;
}

type SortKey = "address" | "share";

export default function CollaboratorTable({ contractId, refreshKey }: Props) {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("share");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!contractId) return;
    setLoading(true);
    setError("");
    api
      .getCollaborators(contractId)
      .then(setCollaborators)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [contractId, refreshKey]);

  function copyAddress(address: string) {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(address);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  if (!contractId) return null;
  if (loading) return <div className="card status info">Loading collaborators…</div>;
  if (error) return <div className="card status error">{error}</div>;
  if (!collaborators.length)
    return (
      <div className="card">
        <span className="badge">Collaborators</span>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
          No collaborators found. Initialize the contract to add collaborators.
        </p>
      </div>
    );

  const filtered = collaborators
    .filter((c) => c.address.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) =>
      sort === "address"
        ? a.address.localeCompare(b.address)
        : b.basisPoints - a.basisPoints,
    );

  return (
    <div className="card">
      <span className="badge">Collaborators</span>
      <div className="row" style={{ marginBottom: "0.75rem", gap: "0.5rem" }}>
        <input
          placeholder="Search by address…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          className={sort === "address" ? "btn-primary" : "btn-add"}
          onClick={() => setSort("address")}
        >
          A–Z
        </button>
        <button
          className={sort === "share" ? "btn-primary" : "btn-add"}
          onClick={() => setSort("share")}
        >
          Share ↓
        </button>
      </div>
      <div style={{ marginBottom: "0.5rem", fontSize: "0.85rem", opacity: 0.7 }}>
        {filtered.length} of {collaborators.length} collaborator{collaborators.length !== 1 ? "s" : ""}
      </div>
      <table>
        <thead>
          <tr>
            <th>Address</th>
            <th style={{ textAlign: "right" }}>Share</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((c) => (
            <tr key={c.address}>
              <td>
                <span title={c.address}>
                  {c.address.slice(0, 8)}...{c.address.slice(-6)}
                </span>
                <button
                  className="copy-btn-sm"
                  onClick={() => navigator.clipboard.writeText(c.address)}
                  title="Copy address"
                >
                  ⧉
                </button>
              </td>
              <td style={{ textAlign: "right" }}>
                <span>{(c.basisPoints / 100).toFixed(2)}%</span>
                <div
                  className="share-bar"
                  style={{ width: `${c.basisPoints / 100}%` }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
