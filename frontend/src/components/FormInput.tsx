import { InputHTMLAttributes, useState, useEffect } from "react";

interface FormInputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  showSuccess?: boolean;
  label?: string;
  wrapperClassName?: string;
}

const ErrorIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

const SuccessIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export default function FormInput({
  error,
  showSuccess = false,
  label,
  wrapperClassName = "",
  className = "",
  value,
  ...props
}: FormInputProps) {
  const [shouldAnimate, setShouldAnimate] = useState(false);
  const [prevError, setPrevError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (error === prevError) return;

    setPrevError(error);
    if (!error) {
      setShouldAnimate(false);
      return;
    }

    setShouldAnimate(true);
    const timer = setTimeout(() => setShouldAnimate(false), 500);
    return () => clearTimeout(timer);
  }, [error, prevError]);

  const wrapperClasses = [
    "input-wrapper",
    error && shouldAnimate ? "input-wrapper--error" : "",
    showSuccess && !error ? "input-wrapper--success" : "",
    wrapperClassName,
  ]
    .filter(Boolean)
    .join(" ");

  const inputClasses = [
    className,
    error ? "input-error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={wrapperClasses}>
      {label && <label htmlFor={props.id}>{label}</label>}
      <div style={{ position: "relative" }}>
        <input
          {...props}
          value={value}
          className={inputClasses}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `${props.id}-error` : undefined}
          style={{ paddingRight: error || showSuccess ? "40px" : undefined }}
        />
        {error && (
          <span className="input-icon input-icon--error" aria-hidden="true">
            <ErrorIcon />
          </span>
        )}
        {showSuccess && !error && (
          <span className="input-icon input-icon--success" aria-hidden="true">
            <SuccessIcon />
          </span>
        )}
      </div>
      {error && (
        <span id={`${props.id}-error`} className="input-error-message" role="alert">
          <ErrorIcon />
          {error}
        </span>
      )}
    </div>
  );
}
