/**
 * NotificationContext (#417)
 *
 * App-wide toast notifications replacing browser alerts. Supports
 * success/error/warning/info types, optional Retry/Copy/Dismiss actions,
 * configurable auto-dismiss, bottom-right stacking, and a max of 3 visible
 * toasts (the rest are queued). Styling is theme-aware (data-theme).
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import "./NotificationToast.css";

export type ToastType = "success" | "error" | "warning" | "info";

export interface NotifyOptions {
  type?: ToastType;
  title?: string;
  message: string;
  /** Auto-dismiss after this many ms. Default 5000; 0 disables auto-dismiss. */
  duration?: number;
  /** When set, a Retry button is shown that runs this then dismisses. */
  onRetry?: () => void;
  /** When set, a Copy button copies this text (handles long text). */
  copyText?: string;
}

interface Toast extends NotifyOptions {
  id: number;
  type: ToastType;
  duration: number;
}

interface NotificationContextValue {
  notify: (opts: NotifyOptions) => number;
  success: (message: string, opts?: Omit<NotifyOptions, "message" | "type">) => number;
  error: (message: string, opts?: Omit<NotifyOptions, "message" | "type">) => number;
  warning: (message: string, opts?: Omit<NotifyOptions, "message" | "type">) => number;
  info: (message: string, opts?: Omit<NotifyOptions, "message" | "type">) => number;
  dismiss: (id: number) => void;
}

export const MAX_VISIBLE_TOASTS = 3;
export const DEFAULT_TOAST_DURATION_MS = 5000;

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

const ICONS: Record<ToastType, string> = {
  success: "✓",
  error: "✕",
  warning: "⚠",
  info: "ℹ",
};

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [visible, setVisible] = useState<Toast[]>([]);
  const queueRef = useRef<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setVisible((prev) => {
      const remaining = prev.filter((t) => t.id !== id);
      // Promote a queued toast into the freed slot.
      if (remaining.length < MAX_VISIBLE_TOASTS && queueRef.current.length > 0) {
        const next = queueRef.current.shift()!;
        return [...remaining, next];
      }
      return remaining;
    });
  }, []);

  const notify = useCallback((opts: NotifyOptions): number => {
    const toast: Toast = {
      id: nextId.current++,
      type: opts.type ?? "info",
      duration: opts.duration ?? DEFAULT_TOAST_DURATION_MS,
      title: opts.title,
      message: opts.message,
      onRetry: opts.onRetry,
      copyText: opts.copyText,
    };
    setVisible((prev) => {
      if (prev.length >= MAX_VISIBLE_TOASTS) {
        queueRef.current.push(toast);
        return prev;
      }
      return [...prev, toast];
    });
    return toast.id;
  }, []);

  const byType = useCallback(
    (type: ToastType) =>
      (message: string, opts?: Omit<NotifyOptions, "message" | "type">) =>
        notify({ ...opts, type, message }),
    [notify],
  );

  const value: NotificationContextValue = {
    notify,
    success: byType("success"),
    error: byType("error"),
    warning: byType("warning"),
    info: byType("info"),
    dismiss,
  };

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <div className="toast-container" role="region" aria-label="Notifications">
        {visible.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </NotificationContext.Provider>
  );
};

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (toast.duration <= 0) return;
    const timer = setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);

  async function handleCopy() {
    if (!toast.copyText) return;
    try {
      await navigator.clipboard.writeText(toast.copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={`toast toast--${toast.type}`} role="alert" data-testid="toast">
      <span className="toast__icon" aria-hidden="true">
        {ICONS[toast.type]}
      </span>
      <div className="toast__body">
        {toast.title && <div className="toast__title">{toast.title}</div>}
        <div className="toast__message">{toast.message}</div>
        <div className="toast__actions">
          {toast.onRetry && (
            <button
              type="button"
              className="toast__action"
              onClick={() => {
                toast.onRetry?.();
                onDismiss(toast.id);
              }}
            >
              Retry
            </button>
          )}
          {toast.copyText && (
            <button type="button" className="toast__action" onClick={handleCopy}>
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      </div>
      <button
        type="button"
        className="toast__dismiss"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

export function useNotification(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error("useNotification must be used within NotificationProvider");
  }
  return ctx;
}
