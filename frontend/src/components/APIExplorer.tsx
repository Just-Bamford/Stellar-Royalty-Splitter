import React, { useState, useEffect } from "react";
import { RequestBuilder } from "./RequestBuilder";
import { ResponseViewer } from "./ResponseViewer";
import "./EarningsForecastCalculator.css";

export interface EndpointDef {
  id: string;
  name: string;
  method: string;
  path: string;
  description: string;
  defaultParams?: Record<string, string>;
  defaultBody?: string;
}

export const ENDPOINTS_LIST: EndpointDef[] = [
  {
    id: "get-analytics",
    name: "Get Contract Analytics",
    method: "GET",
    path: "/api/v1/analytics/:contractId",
    description: "Retrieve aggregated payment and transaction analytics for a contract.",
    defaultParams: { contractId: "C1234567890" },
  },
  {
    id: "get-forecast",
    name: "Get Earnings Forecast",
    method: "GET",
    path: "/api/v1/analytics/forecast",
    description: "Calculate 3/6/12 month projected earnings and scenario bands.",
    defaultParams: { frequency: "monthly", avgPayout: "100", secondaryVolume: "5000" },
  },
  {
    id: "list-collaborators",
    name: "List Collaborators",
    method: "GET",
    path: "/api/v1/collaborators",
    description: "Fetch directory of contract collaborators and royalty shares.",
    defaultParams: { limit: "20", page: "1" },
  },
  {
    id: "distribute-royalties",
    name: "Distribute Royalties",
    method: "POST",
    path: "/api/v1/distribute",
    description: "Trigger primary royalty distribution across collaborators.",
    defaultBody: JSON.stringify({ contractId: "C1234567890", amount: "1000" }, null, 2),
  },
];

export const APIExplorer: React.FC = () => {
  const [selectedEndpoint, setSelectedEndpoint] = useState<EndpointDef>(ENDPOINTS_LIST[0]);
  const [method, setMethod] = useState(ENDPOINTS_LIST[0].method);
  const [path, setPath] = useState(ENDPOINTS_LIST[0].path);
  const [queryParams, setQueryParams] = useState<Record<string, string>>(
    ENDPOINTS_LIST[0].defaultParams || {}
  );
  const [headers, setHeaders] = useState<Record<string, string>>({
    "Content-Type": "application/json",
  });
  const [body, setBody] = useState(ENDPOINTS_LIST[0].defaultBody || "");
  const [apiKey, setApiKey] = useState("");

  const [response, setResponse] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [savedRequests, setSavedRequests] = useState<EndpointDef[]>([]);

  useEffect(() => {
    const stored = localStorage.getItem("saved_api_requests");
    if (stored) {
      try {
        setSavedRequests(JSON.parse(stored));
      } catch (_) {
        // ignore
      }
    }
  }, []);

  const selectEndpoint = (ep: EndpointDef) => {
    setSelectedEndpoint(ep);
    setMethod(ep.method);
    setPath(ep.path);
    setQueryParams(ep.defaultParams || {});
    setBody(ep.defaultBody || "");
  };

  const saveCurrentRequest = () => {
    const newSaved = [
      ...savedRequests,
      {
        id: `saved-${Date.now()}`,
        name: `${method} ${path}`,
        method,
        path,
        description: "Saved request",
        defaultParams: queryParams,
        defaultBody: body,
      },
    ];
    setSavedRequests(newSaved);
    localStorage.setItem("saved_api_requests", JSON.stringify(newSaved));
  };

  const handleSendRequest = async () => {
    setIsLoading(true);
    const start = Date.now();

    try {
      let finalUrl = path;
      const q = new URLSearchParams(queryParams).toString();
      if (q) finalUrl += `?${q}`;

      const reqHeaders: Record<string, string> = { ...headers };
      if (apiKey) {
        reqHeaders["X-API-Key"] = apiKey;
      }

      const options: RequestInit = {
        method,
        headers: reqHeaders,
      };

      if (method !== "GET" && method !== "HEAD" && body) {
        options.body = body;
      }

      const res = await fetch(finalUrl, options);
      const durationMs = Date.now() - start;
      const resData = await res.json().catch(() => ({ message: "Non-JSON response" }));

      const resHeadersObj: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        resHeadersObj[k] = v;
      });

      setResponse({
        status: res.status,
        statusText: res.statusText,
        durationMs,
        headers: resHeadersObj,
        data: resData,
        curl: `curl -X ${method} "${window.location.origin}${finalUrl}" ${Object.entries(reqHeaders)
          .map(([k, v]) => `-H "${k}: ${v}"`)
          .join(" ")} ${body ? `-d '${body}'` : ""}`,
        js: `fetch("${finalUrl}", {\n  method: "${method}",\n  headers: ${JSON.stringify(reqHeaders, null, 2)}\n});`,
        python: `import requests\nres = requests.${method.toLowerCase()}("${finalUrl}", headers=${JSON.stringify(reqHeaders)})\nprint(res.json())`,
      });
    } catch (err: any) {
      setResponse({
        status: 500,
        statusText: "Network Error",
        durationMs: Date.now() - start,
        data: { error: err.message || "Failed to reach server" },
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="card api-explorer" data-testid="api-explorer">
      <div className="explorer-sidebar">
        <h2>API Explorer</h2>
        <div className="endpoints-group">
          <h3>Endpoints</h3>
          {ENDPOINTS_LIST.map((ep) => (
            <button
              key={ep.id}
              type="button"
              className={`endpoint-item ${selectedEndpoint.id === ep.id ? "active" : ""}`}
              onClick={() => selectEndpoint(ep)}
              data-testid={`endpoint-btn-${ep.id}`}
            >
              <span className={`method-pill method-${ep.method.toLowerCase()}`}>{ep.method}</span>
              <span className="endpoint-name">{ep.name}</span>
            </button>
          ))}
        </div>

        {savedRequests.length > 0 && (
          <div className="saved-requests-group">
            <h3>Saved Requests ({savedRequests.length})</h3>
            {savedRequests.map((sr) => (
              <button
                key={sr.id}
                type="button"
                className="endpoint-item"
                onClick={() => selectEndpoint(sr)}
              >
                <span className="method-pill">{sr.method}</span>
                <span className="endpoint-name">{sr.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="explorer-main">
        <div className="explorer-header">
          <h2>{selectedEndpoint.name}</h2>
          <p>{selectedEndpoint.description}</p>
          <button type="button" onClick={saveCurrentRequest} className="bookmark-btn" data-testid="bookmark-btn">
            ⭐ Bookmark Request
          </button>
        </div>

        <RequestBuilder
          method={method}
          path={path}
          headers={headers}
          queryParams={queryParams}
          body={body}
          apiKey={apiKey}
          onMethodChange={setMethod}
          onPathChange={setPath}
          onHeadersChange={setHeaders}
          onQueryParamsChange={setQueryParams}
          onBodyChange={setBody}
          onApiKeyChange={setApiKey}
          onSubmit={handleSendRequest}
          isLoading={isLoading}
        />

        {response && (
          <ResponseViewer
            status={response.status}
            statusText={response.statusText}
            durationMs={response.durationMs}
            headers={response.headers}
            data={response.data}
            curlCommand={response.curl}
            jsCode={response.js}
            pythonCode={response.python}
          />
        )}
      </div>
    </div>
  );
};
