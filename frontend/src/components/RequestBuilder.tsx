import React, { useState } from "react";

export interface RequestBuilderProps {
  method: string;
  path: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  body: string;
  apiKey: string;
  onMethodChange: (m: string) => void;
  onPathChange: (p: string) => void;
  onHeadersChange: (h: Record<string, string>) => void;
  onQueryParamsChange: (q: Record<string, string>) => void;
  onBodyChange: (b: string) => void;
  onApiKeyChange: (k: string) => void;
  onSubmit: () => void;
  isLoading?: boolean;
}

export const RequestBuilder: React.FC<RequestBuilderProps> = ({
  method,
  path,
  headers,
  queryParams,
  body,
  apiKey,
  onMethodChange,
  onPathChange,
  onHeadersChange,
  onQueryParamsChange,
  onBodyChange,
  onApiKeyChange,
  onSubmit,
  isLoading = false,
}) => {
  const [activeTab, setActiveTab] = useState<"params" | "headers" | "body" | "auth">("params");

  return (
    <div className="request-builder" data-testid="request-builder">
      <div className="request-bar">
        <select
          value={method}
          onChange={(e) => onMethodChange(e.target.value)}
          className={`method-select method-${method.toLowerCase()}`}
          data-testid="method-select"
        >
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
        </select>

        <input
          type="text"
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
          className="path-input"
          placeholder="/api/v1/..."
          data-testid="path-input"
        />

        <button
          type="button"
          onClick={onSubmit}
          disabled={isLoading}
          className="try-it-btn"
          data-testid="try-it-btn"
        >
          {isLoading ? "Sending..." : "Try It"}
        </button>
      </div>

      <div className="request-tabs">
        <button
          type="button"
          className={`tab-btn ${activeTab === "params" ? "active" : ""}`}
          onClick={() => setActiveTab("params")}
          data-testid="tab-params"
        >
          Query Params
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === "headers" ? "active" : ""}`}
          onClick={() => setActiveTab("headers")}
          data-testid="tab-headers"
        >
          Headers
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === "body" ? "active" : ""}`}
          onClick={() => setActiveTab("body")}
          data-testid="tab-body"
        >
          Body
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === "auth" ? "active" : ""}`}
          onClick={() => setActiveTab("auth")}
          data-testid="tab-auth"
        >
          Auth
        </button>
      </div>

      <div className="tab-content">
        {activeTab === "params" && (
          <div className="params-tab">
            <textarea
              rows={4}
              value={JSON.stringify(queryParams, null, 2)}
              onChange={(e) => {
                try {
                  onQueryParamsChange(JSON.parse(e.target.value));
                } catch (_) {
                  // ignore parse error during edit
                }
              }}
              placeholder='{ "contractId": "C123..." }'
              data-testid="query-params-input"
            />
          </div>
        )}

        {activeTab === "headers" && (
          <div className="headers-tab">
            <textarea
              rows={4}
              value={JSON.stringify(headers, null, 2)}
              onChange={(e) => {
                try {
                  onHeadersChange(JSON.parse(e.target.value));
                } catch (_) {
                  // ignore
                }
              }}
              data-testid="headers-input"
            />
          </div>
        )}

        {activeTab === "body" && (
          <div className="body-tab">
            <textarea
              rows={6}
              value={body}
              onChange={(e) => onBodyChange(e.target.value)}
              placeholder='{ "key": "value" }'
              data-testid="body-input"
            />
          </div>
        )}

        {activeTab === "auth" && (
          <div className="auth-tab">
            <label htmlFor="api-key-input">API Key (X-API-Key)</label>
            <input
              id="api-key-input"
              type="text"
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
              placeholder="Paste API Key here..."
              data-testid="api-key-input"
            />
          </div>
        )}
      </div>
    </div>
  );
};
