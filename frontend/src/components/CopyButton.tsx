import { useState, useCallback } from "react";

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
  size?: "sm" | "md";
  /** Called after the value is successfully copied (e.g. to show a toast). */
  onCopied?: () => void;
}

export function CopyButton({
  value,
  label = "Copy",
  className = "",
  size = "md",
  onCopied,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        onCopied?.();
        setTimeout(() => setCopied(false), 2000);
      } catch {
        setCopied(false);
      }
    },
    [value, onCopied],
  );

  const sizeClass = size === "sm" ? "copy-btn-sm" : "copy-btn";

  return (
    <button
      type="button"
      className={`${sizeClass} ${copied ? "copied" : ""} ${className}`.trim()}
      onClick={handleCopy}
      aria-label={copied ? "Copied to clipboard" : `Copy ${label}`}
      title={copied ? "Copied" : `Copy ${label}`}
    >
      {copied ? "✓ Copied" : "📋 Copy"}
    </button>
  );
}
