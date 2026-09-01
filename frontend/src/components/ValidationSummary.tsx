export interface ValidationSummaryIssue {
  /** Row index the issue belongs to, or -1 for a form-wide issue (e.g. share total). */
  index: number;
  field: "address" | "basisPoints";
  message: string;
}

interface ValidationSummaryProps {
  issues: ValidationSummaryIssue[];
  onFocusField: (index: number, field: "address" | "basisPoints") => void;
}

/**
 * Single overview of every active royalty-configuration validation issue
 * (issue #694). Reuses the same per-row and aggregate checks InitializeForm
 * already runs on submit — this only surfaces their current results.
 */
export default function ValidationSummary({ issues, onFocusField }: ValidationSummaryProps) {
  const isValid = issues.length === 0;

  return (
    <div
      className={`validation-summary ${isValid ? "validation-summary--valid" : "validation-summary--invalid"}`}
      role="region"
      aria-live="polite"
      aria-label="Configuration validation summary"
      data-testid="validation-summary"
    >
      {isValid ? (
        <p className="validation-summary__status" data-testid="validation-summary-status">
          ✓ Ready to deploy — all fields are valid.
        </p>
      ) : (
        <>
          <p className="validation-summary__status" role="alert" data-testid="validation-summary-status">
            {issues.length} issue{issues.length === 1 ? "" : "s"} to fix before deploying:
          </p>
          <ul className="validation-summary__list">
            {issues.map((issue) => (
              <li key={`${issue.index}-${issue.field}-${issue.message}`}>
                {issue.index >= 0 ? (
                  <button
                    type="button"
                    className="validation-summary__link"
                    onClick={() => onFocusField(issue.index, issue.field)}
                  >
                    {issue.message}
                  </button>
                ) : (
                  <span>{issue.message}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
