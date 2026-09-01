import React from 'react';

interface AccessibleButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  loadingText?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const AccessibleButton: React.FC<AccessibleButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  isLoading = false,
  loadingText,
  leftIcon,
  rightIcon,
  disabled,
  className = '',
  ...props
}) => {
  const variantClasses = {
    primary: 'a11y-btn-primary',
    secondary: 'a11y-btn-secondary',
    danger: 'a11y-btn-danger',
  };

  const sizeClasses = {
    sm: 'a11y-btn-sm',
    md: 'a11y-btn-md',
    lg: 'a11y-btn-lg',
  };

  return (
    <button
      className={`a11y-btn ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled || isLoading}
      aria-disabled={disabled || isLoading}
      aria-busy={isLoading}
      {...props}
    >
      {isLoading && (
        <span className="a11y-btn-spinner" aria-hidden="true">
          <svg
            className="a11y-btn-spinner-icon"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="a11y-btn-spinner-circle"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="a11y-btn-spinner-path"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        </span>
      )}
      {!isLoading && leftIcon && (
        <span className="a11y-btn-icon-left" aria-hidden="true">
          {leftIcon}
        </span>
      )}
      <span className="a11y-btn-text">
        {isLoading ? loadingText || 'Loading...' : children}
      </span>
      {!isLoading && rightIcon && (
        <span className="a11y-btn-icon-right" aria-hidden="true">
          {rightIcon}
        </span>
      )}
    </button>
  );
};

export default AccessibleButton;
