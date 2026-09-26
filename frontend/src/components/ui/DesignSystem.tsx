import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import "./design-system.css";

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export function Stack({ gap = "md", className = "", ...props }: HTMLAttributes<HTMLDivElement> & { gap?: "xs" | "sm" | "md" | "lg" | "xl" }) {
  return <div className={`ds-stack ds-stack--${gap} ${className}`.trim()} {...props} />;
}

export function Card({ tone = "default", className = "", ...props }: HTMLAttributes<HTMLDivElement> & { tone?: "default" | "interactive" }) {
  return <section className={`ds-card ds-card--${tone} ${className}`.trim()} {...props} />;
}

export function Badge({ tone = "neutral", children, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: StatusTone; children: ReactNode }) {
  return <span className={`ds-badge ds-badge--${tone}`} {...props}>{children}</span>;
}

export function Button({ variant = "primary", size = "md", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" | "lg" }) {
  return <button className={`ds-button ds-button--${variant} ds-button--${size} ${className}`.trim()} {...props} />;
}

export function Field({ label, hint, error, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  return <label className="ds-field"><span className="ds-field__label">{label}</span><input className={`ds-input${error ? " ds-input--error" : ""}`} aria-invalid={Boolean(error)} {...props} />{error ? <span className="ds-field__error" role="alert">{error}</span> : hint ? <span className="ds-field__hint">{hint}</span> : null}</label>;
}

export function Alert({ tone = "info", children, ...props }: HTMLAttributes<HTMLDivElement> & { tone?: StatusTone; children: ReactNode }) {
  return <div className={`ds-alert ds-alert--${tone}`} role="status" {...props}>{children}</div>;
}
