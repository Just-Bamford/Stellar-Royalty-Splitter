import { useCallback, useMemo, useState } from "react";

export type SegmentDescriptor = {
  id: string;
  dimension: "earnings" | "activity" | "tenure" | "geography";
  label: string;
  size: number;
};

export type TargetRule = {
  earnings?: string[];
  activity?: string[];
  tenure?: string[];
  geography?: string[];
  match?: "all" | "any";
};

export type CampaignVariant = {
  id: string;
  name: string;
  weight: number;
  subject?: string;
  body?: string;
};

export type CampaignAnalytics = {
  campaignId: string;
  name: string;
  targetSize: number;
  openRate: number;
  clickRate: number;
  conversionRate: number;
  variants: Array<{
    variantId: string;
    variantName: string;
    openRate: number;
    clickRate: number;
    conversionRate: number;
  }>;
  bestVariantId: string | null;
};

export interface CampaignBuilderProps {
  segments: SegmentDescriptor[];
  onCreateCampaign: (payload: {
    name: string;
    channel: string;
    target: { segmentId?: string; rule?: TargetRule };
    variants: CampaignVariant[];
  }) => Promise<void> | void;
  onExportAudience?: (campaignId: string) => Promise<string> | void;
  analytics?: CampaignAnalytics | null;
}

const DIMENSION_LABELS: Record<SegmentDescriptor["dimension"], string> = {
  earnings: "Earnings",
  activity: "Activity",
  tenure: "Tenure",
  geography: "Geography",
};

function formatRate(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

export default function CampaignBuilder({
  segments,
  onCreateCampaign,
  onExportAudience,
  analytics = null,
}: CampaignBuilderProps) {
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("email");
  const [selectedSegmentId, setSelectedSegmentId] = useState<string>("");
  const [matchMode, setMatchMode] = useState<"all" | "any">("all");
  const [rule, setRule] = useState<TargetRule>({ match: "all" });
  const [variants, setVariants] = useState<CampaignVariant[]>([
    { id: "var_a", name: "A", weight: 1, subject: "", body: "" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupedSegments = useMemo(() => {
    const groups: Record<string, SegmentDescriptor[]> = {};
    for (const segment of segments) {
      if (!groups[segment.dimension]) groups[segment.dimension] = [];
      groups[segment.dimension].push(segment);
    }
    return groups;
  }, [segments]);

  const totalSegmentSize = useMemo(() => segments.reduce((sum, s) => sum + s.size, 0), [segments]);

  const toggleRuleValue = useCallback(
    (dimension: keyof TargetRule, value: string) => {
      setRule((prev) => {
        const current = Array.isArray(prev[dimension]) ? (prev[dimension] as string[]) : [];
        const next = current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value];
        return { ...prev, [dimension]: next, match: matchMode };
      });
    },
    [matchMode]
  );

  const updateVariant = useCallback((id: string, patch: Partial<CampaignVariant>) => {
    setVariants((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  }, []);

  const addVariant = useCallback(() => {
    setVariants((prev) => [
      ...prev,
      {
        id: `var_${Date.now()}_${prev.length}`,
        name: String.fromCharCode(65 + prev.length),
        weight: 1,
        subject: "",
        body: "",
      },
    ]);
  }, []);

  const removeVariant = useCallback((id: string) => {
    setVariants((prev) => (prev.length <= 1 ? prev : prev.filter((v) => v.id !== id)));
  }, []);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);
      if (!name.trim()) {
        setError("Campaign name is required");
        return;
      }
      if (!selectedSegmentId && !Object.keys(rule).some((k) => k !== "match")) {
        setError("Select a segment or at least one targeting rule");
        return;
      }
      try {
        setSubmitting(true);
        await onCreateCampaign({
          name: name.trim(),
          channel,
          target: selectedSegmentId
            ? { segmentId: selectedSegmentId }
            : { rule: { ...rule, match: matchMode } },
          variants,
        });
        setName("");
        setSelectedSegmentId("");
        setRule({ match: "all" });
      } catch (err) {
        setError((err as Error).message || "Failed to create campaign");
      } finally {
        setSubmitting(false);
      }
    },
    [name, channel, selectedSegmentId, rule, matchMode, variants, onCreateCampaign]
  );

  return (
    <div className="campaign-builder">
      <header className="campaign-builder__header">
        <h2>Targeting dashboard</h2>
        <p>Total contributors across segments: {totalSegmentSize}</p>
      </header>

      <section aria-label="Segments" className="campaign-builder__segments">
        <h3>Segments</h3>
        {(Object.keys(groupedSegments) as Array<SegmentDescriptor["dimension"]>).map(
          (dimension) => (
            <div key={dimension} className="campaign-builder__dimension">
              <h4>{DIMENSION_LABELS[dimension]}</h4>
              <ul>
                {groupedSegments[dimension].map((segment) => (
                  <li key={segment.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedSegmentId(segment.id)}
                      aria-pressed={selectedSegmentId === segment.id}
                    >
                      {segment.label} ({segment.size})
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )
        )}
      </section>

      <section aria-label="Targeting rules" className="campaign-builder__rules">
        <h3>Targeting rules</h3>
        <label>
          Match mode:
          <select value={matchMode} onChange={(e) => setMatchMode(e.target.value as "all" | "any")}>
            <option value="all">All conditions</option>
            <option value="any">Any condition</option>
          </select>
        </label>
        {(
          [
            ["earnings", ["high", "medium", "low"]],
            ["activity", ["active", "inactive", "churned"]],
            ["tenure", ["new", "established", "veteran"]],
          ] as Array<[keyof TargetRule, string[]]>
        ).map(([dimension, values]) => (
          <fieldset key={dimension}>
            <legend>{DIMENSION_LABELS[dimension as keyof typeof DIMENSION_LABELS]}</legend>
            {values.map((value) => (
              <label key={value}>
                <input
                  type="checkbox"
                  checked={
                    Array.isArray(rule[dimension]) && (rule[dimension] as string[]).includes(value)
                  }
                  onChange={() => toggleRuleValue(dimension, value)}
                />
                {value}
              </label>
            ))}
          </fieldset>
        ))}
      </section>

      <form onSubmit={handleSubmit} className="campaign-builder__form">
        <h3>Create campaign</h3>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Channel
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="in-app">In-app</option>
          </select>
        </label>

        <fieldset className="campaign-builder__variants">
          <legend>A/B variants</legend>
          {variants.map((variant) => (
            <div key={variant.id} className="campaign-builder__variant">
              <label>
                Name
                <input
                  value={variant.name}
                  onChange={(e) => updateVariant(variant.id, { name: e.target.value })}
                />
              </label>
              <label>
                Weight
                <input
                  type="number"
                  min="1"
                  value={variant.weight}
                  onChange={(e) =>
                    updateVariant(variant.id, { weight: Number(e.target.value) || 1 })
                  }
                />
              </label>
              <label>
                Subject
                <input
                  value={variant.subject ?? ""}
                  onChange={(e) => updateVariant(variant.id, { subject: e.target.value })}
                />
              </label>
              <label>
                Body
                <textarea
                  value={variant.body ?? ""}
                  onChange={(e) => updateVariant(variant.id, { body: e.target.value })}
                />
              </label>
              {variants.length > 1 && (
                <button type="button" onClick={() => removeVariant(variant.id)}>
                  Remove variant
                </button>
              )}
            </div>
          ))}
          <button type="button" onClick={addVariant}>
            Add variant
          </button>
        </fieldset>

        {error && <p className="campaign-builder__error">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Creating…" : "Create campaign"}
        </button>
      </form>

      {analytics && (
        <section aria-label="Campaign analytics" className="campaign-builder__analytics">
          <h3>Campaign performance</h3>
          <p>Target size: {analytics.targetSize}</p>
          <ul>
            <li>Open rate: {formatRate(analytics.openRate)}</li>
            <li>Click rate: {formatRate(analytics.clickRate)}</li>
            <li>Conversion rate: {formatRate(analytics.conversionRate)}</li>
          </ul>
          <table>
            <thead>
              <tr>
                <th>Variant</th>
                <th>Open</th>
                <th>Click</th>
                <th>Conversion</th>
              </tr>
            </thead>
            <tbody>
              {analytics.variants.map((variant) => (
                <tr key={variant.variantId}>
                  <td>{variant.variantName}</td>
                  <td>{formatRate(variant.openRate)}</td>
                  <td>{formatRate(variant.clickRate)}</td>
                  <td>{formatRate(variant.conversionRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {analytics.bestVariantId && <p>Best variant: {analytics.bestVariantId}</p>}
          {onExportAudience && (
            <button type="button" onClick={() => onExportAudience(analytics.campaignId)}>
              Export audience CSV
            </button>
          )}
        </section>
      )}
    </div>
  );
}
