export type FormStatusType = "ok" | "error" | "info";

interface FormStatusProps {
  type: FormStatusType;
  message: string;
}

export default function FormStatus({ type, message }: FormStatusProps) {
  return <div className={`form-status form-status--${type}`}>{message}</div>;
}