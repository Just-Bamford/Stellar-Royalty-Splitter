import type { CSSProperties, ReactNode } from "react";

export type RecommendationKind = "collection" | "collaborator";

export interface RecommendationItem {
  id: string;
  name: string;
  score: number;
  confidence?: number;
  reason?: string;
  type?: RecommendationKind;
  sharedProjects?: number;
}

interface RecommendationsProps {
  collections?: RecommendationItem[];
  collaborators?: RecommendationItem[];
  targetCollection?: string;
  targetCollaborator?: string;
}

const defaultCollections: RecommendationItem[] = [
  {
    id: "c1",
    name: "Neon District",
    score: 0.92,
    confidence: 0.94,
    reason: "Shared cyberpunk aesthetic and price range",
    type: "collection",
  },
  {
    id: "c2",
    name: "Future Arcades",
    score: 0.81,
    confidence: 0.85,
    reason: "Similar rarity profile and collector audience",
    type: "collection",
  },
  {
    id: "c3",
    name: "Glass Horizon",
    score: 0.74,
    confidence: 0.8,
    reason: "Strong thematic overlap with a premium floor",
    type: "collection",
  },
];

const defaultCollaborators: RecommendationItem[] = [
  {
    id: "u1",
    name: "Astra Lane",
    score: 0.88,
    confidence: 0.91,
    reason: "Collaborators who worked with you also worked with Astra",
    type: "collaborator",
    sharedProjects: 3,
  },
  {
    id: "u2",
    name: "Milo Quill",
    score: 0.77,
    confidence: 0.82,
    reason: "Strong project overlap and complementary creative style",
    type: "collaborator",
    sharedProjects: 2,
  },
  {
    id: "u3",
    name: "Rae Flux",
    score: 0.69,
    confidence: 0.74,
    reason: "Curated fit for premium and collectible launches",
    type: "collaborator",
    sharedProjects: 1,
  },
];

function formatPercent(value: number) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function RecommendationRow({ item }: { item: RecommendationItem }) {
  const confidence = item.confidence ?? item.score;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.5fr) auto auto",
        gap: 12,
        alignItems: "center",
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: "12px 14px",
        background: "#ffffff",
      }}
    >
      <div>
        <div style={{ fontWeight: 700, color: "#111827" }}>{item.name}</div>
        <div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>
          {item.reason}
        </div>
      </div>
      <div style={{ fontWeight: 700, color: "#2563eb" }}>
        {formatPercent(item.score)}
      </div>
      <div style={{ fontSize: 12, color: "#374151" }}>
        <div>Confidence {formatPercent(confidence)}</div>
        {item.type === "collaborator" &&
        typeof item.sharedProjects === "number" ? (
          <div style={{ marginTop: 2 }}>Shared work: {item.sharedProjects}</div>
        ) : null}
      </div>
    </div>
  );
}

export default function Recommendations({
  collections = defaultCollections,
  collaborators = defaultCollaborators,
  targetCollection,
  targetCollaborator,
}: RecommendationsProps) {
  const collectionList =
    collections.length > 0 ? collections : defaultCollections;
  const collaboratorList =
    collaborators.length > 0 ? collaborators : defaultCollaborators;

  return (
    <section
      style={{
        display: "grid",
        gap: 20,
        padding: 20,
        borderRadius: 16,
        background: "linear-gradient(180deg, #f8fafc 0%, #f3f4f6 100%)",
        border: "1px solid #e5e7eb",
        maxWidth: 920,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              color: "#2563eb",
              fontSize: 12,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            Recommendations
          </div>
          <h3 style={{ margin: "6px 0 0", color: "#111827" }}>
            Similar collections and collaborators
          </h3>
        </div>
        <div style={{ color: "#374151", fontSize: 12 }}>
          {targetCollection ? `For ${targetCollection}` : "Discovery feed"}
          {targetCollaborator ? ` · ${targetCollaborator}` : ""}
        </div>
      </header>

      <div style={{ display: "grid", gap: 16 }}>
        <div>
          <h4 style={{ margin: "0 0 10px", color: "#111827" }}>
            Similar collections
          </h4>
          <div style={{ display: "grid", gap: 10 }}>
            {collectionList.map((item) => (
              <RecommendationRow key={item.id} item={item} />
            ))}
          </div>
        </div>

        <div>
          <h4 style={{ margin: "0 0 10px", color: "#111827" }}>
            Recommended collaborators
          </h4>
          <div style={{ display: "grid", gap: 10 }}>
            {collaboratorList.map((item) => (
              <RecommendationRow key={item.id} item={item} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export { Recommendations };
