import type { Dispute } from "../hooks/queries/useDisputes";

interface DisputeTimelineProps {
  dispute: Dispute;
}

export function DisputeTimeline({ dispute }: DisputeTimelineProps) {
  const steps = [
    {
      label: "Created",
      date: dispute.createdAt,
      complete: true,
    },
    {
      label: "Responded",
      date: dispute.respondedAt || dispute.createdAt,
      complete: Boolean(dispute.respondedAt),
    },
    {
      label: "Resolved",
      date: dispute.resolvedAt || dispute.respondedAt || dispute.createdAt,
      complete: dispute.status !== "open",
    },
  ];

  return (
    <div className="dispute-timeline" aria-label="Dispute timeline">
      {steps.map((step, index) => (
        <div
          key={step.label}
          className={`timeline-step ${step.complete ? "complete" : "pending"}`}
        >
          <div className="timeline-marker" aria-hidden="true" />
          {index < steps.length - 1 && <div className="timeline-line" aria-hidden="true" />}
          <div className="timeline-content">
            <strong>{step.label}</strong>
            <span>{new Date(step.date).toLocaleString()}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default DisputeTimeline;
