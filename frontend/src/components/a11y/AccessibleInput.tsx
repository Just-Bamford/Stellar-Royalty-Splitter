import React, { useId } from 'react';

interface AccessibleInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  helperText?: string;
  errorMessage?: string;
  isRequired?: boolean;
  leftAddon?: React.ReactNode;
  rightAddon?: React.ReactNode;
}

export const AccessibleInput: React.FC<AccessibleInputProps> = ({
  label,
  helperText,
  errorMessage,
  isRequired = false,
  leftAddon,
  rightAddon,
  id: providedId,
  className = '',
  ...props
}) => {
  const generatedId = useId();
  const id = providedId || generatedId;
  const helperTextId = `${id}-helper`;
  const errorTextId = `${id}-error`;

  const hasError = !!errorMessage;

  return (
    <div className={`a11y-input-wrapper ${hasError ? 'a11y-input-error' : ''}`}>
      <label
        htmlFor={id}
        className="a11y-input-label"
      >
        {label}
        {isRequired && (
          <span className="a11y-input-required" aria-hidden="true">
            *
          </span>
        )}
      </label>

      <div className="a11y-input-container">
        {leftAddon && (
          <span className="a11y-input-addon-left" aria-hidden="true">
            {leftAddon}
          </span>
        )}

        <input
          id={id}
          className={`a11y-input ${leftAddon ? 'a11y-input-with-left-addon' : ''} ${rightAddon ? 'a11y-input-with-right-addon' : ''} ${className}`}
          aria-required={isRequired}
          aria-invalid={hasError}
          aria-describedby={
            [
              helperText ? helperTextId : null,
              hasError ? errorTextId : null,
            ]
              .filter(Boolean)
              .join(' ') || undefined
          }
          {...props}
        />

        {rightAddon && (
          <span className="a11y-input-addon-right" aria-hidden="true">
            {rightAddon}
          </span>
        )}
      </div>

      {helperText && !hasError && (
        <p id={helperTextId} className="a11y-input-helper">
          {helperText}
        </p>
      )}

      {hasError && (
        <p id={errorTextId} className="a11y-input-error-text" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  );
};

export default AccessibleInput;
