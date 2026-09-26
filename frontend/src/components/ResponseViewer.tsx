import React, { useState } from "react";

export interface ResponseViewerProps {
  status: number | null;
  statusText?: string;
  durationMs?: number;
  headers?: Record<string, string>;
  data: unknown;
  curlCommand?: string;
  jsCode?: string;
  pythonCode?: string;
}

export const ResponseViewer: React.FC<ResponseViewerProps> = ({
  status,
  statusText,
  durationMs,
  headers,
  data,
  curlCommand,
  jsCode,
  pythonCode,
}) => {
  const [copiedType, setCopiedType] = useState<string | null>(null);

  const copyToClipboard = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopiedType(type);
    setTimeout(() => setCopiedType(null), 2000);
  };

  const isSuccess = status !== null && status >= 200 && status < 300;

  return (
    <div className="response-viewer" data-testid="response-viewer">
      <div className="response-header">
        <h3>Response</h3>
        {status !== null && (
          <div className="response-meta">
            <span className={`status-badge ${isSuccess ? "status-success" : "status-error"}`}>
              {status} {statusText}
            </span>
            {durationMs !== undefined && <span className="duration-badge">{durationMs} ms</span>}
          </div>
        )}
      </div>

      <div className="copy-code-actions">
        {curlCommand && (
          <button
            type="button"
            className="copy-btn"
            onClick={() => copyToClipboard(curlCommand, "curl")}
            data-testid="copy-curl-btn"
          >
            {copiedType === "curl" ? "Copied cURL!" : "Copy as cURL"}
          </button>
        )}
        {jsCode && (
          <button
            type="button"
            className="copy-btn"
            onClick={() => copyToClipboard(jsCode, "js")}
            data-testid="copy-js-btn"
          >
            {copiedType === "js" ? "Copied JS!" : "Copy JS"}
          </button>
        )}
        {pythonCode && (
          <button
            type="button"
            className="copy-btn"
            onClick={() => copyToClipboard(pythonCode, "python")}
            data-testid="copy-python-btn"
          >
            {copiedType === "python" ? "Copied Python!" : "Copy Python"}
          </button>
        )}
      </div>

      <div className="response-body-wrapper">
        <pre className="response-json" data-testid="response-json">
          {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
        </pre>
      </div>

      {headers && Object.keys(headers).length > 0 && (
        <details className="response-headers-details">
          <summary>Response Headers ({Object.keys(headers).length})</summary>
          <pre className="headers-json">{JSON.stringify(headers, null, 2)}</pre>
        </details>
      )}
    </div>
  );
};
