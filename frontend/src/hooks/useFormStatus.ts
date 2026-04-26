import { useCallback, useEffect, useState } from "react";
import type { FormStatusType } from "../components/FormStatus";

interface FormStatusState {
  type: FormStatusType;
  message: string;
}

export function useFormStatus(clearAfterMs = 5000) {
  const [status, setStatusState] = useState<FormStatusState | null>(null);

  useEffect(() => {
    if (!status) {
      return;
    }

    const timer = window.setTimeout(() => {
      setStatusState(null);
    }, clearAfterMs);

    return () => window.clearTimeout(timer);
  }, [status, clearAfterMs]);

  const setStatus = useCallback((type: FormStatusType, message: string) => {
    setStatusState({ type, message });
  }, []);

  const clearStatus = useCallback(() => {
    setStatusState(null);
  }, []);

  return { status, setStatus, clearStatus };
}