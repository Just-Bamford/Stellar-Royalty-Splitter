/**
 * OpenTelemetry distributed tracing — enhanced end-to-end instrumentation (#785, #975).
 *
 * Improvements in #975:
 *   - Database query spans: wrapDbQuery(label, fn) adds a span per query
 *   - Contract execution spans: wrapContractCall(contractId, method, fn)
 *   - RPC call spans: wrapRpcCall(label, fn)
 *   - APM multi-backend support: Datadog, New Relic, and Jaeger via env vars
 *   - End-to-end context propagation: frontend → backend → contract → RPC
 *   - Semantic attribute helpers for each layer
 *
 * All additions are backwards-compatible: when OTEL_ENABLED is false every
 * new function degrades gracefully to a no-op wrapper.
 *
 * Environment variables:
 *   OTEL_ENABLED                  – "true" to activate (default: "false")
 *   OTEL_SERVICE_NAME             – service name (default: "stellar-royalty-splitter")
 *   OTEL_SERVICE_VERSION          – service version attached to all spans
 *   OTEL_EXPORTER_OTLP_ENDPOINT   – OTLP/HTTP exporter URL (default: "http://localhost:4318")
 *   JAEGER_ENDPOINT               – alias for OTEL_EXPORTER_OTLP_ENDPOINT (legacy)
 *
 *   APM backend selection (OTEL_APM_BACKEND = "datadog" | "newrelic" | "jaeger" | "otlp"):
 *   OTEL_APM_BACKEND              – selects preset exporter config (default: "otlp")
 *   DD_API_KEY                    – Datadog API key (required when APM_BACKEND=datadog)
 *   DD_SITE                       – Datadog site (default: "datadoghq.com")
 *   NEW_RELIC_LICENSE_KEY         – New Relic ingest key (required when APM_BACKEND=newrelic)
 */

const ENABLED = process.env.OTEL_ENABLED === "true";

// ---------------------------------------------------------------------------
// No-op shims — always present so callers import safely without OTel packages
// ---------------------------------------------------------------------------

const noop = () => {};
const noopSpan = {
  setAttribute:    noop,
  setStatus:       noop,
  recordException: noop,
  end:             noop,
};

const _state = {
  tracer: {
    startActiveSpan: (_name, fn) => fn(noopSpan),
  },
  getTraceId:       () => null,
  addSpanAttributes: noop,
  recordSpanError:  noop,
  getOtelModules:   () => null,
  SpanStatusCode:   { OK: 1, ERROR: 2, UNSET: 0 },
};

// ---------------------------------------------------------------------------
// Public API — core
// ---------------------------------------------------------------------------

/** OTel tracer (or no-op shim). */
export const tracer = {
  startActiveSpan: (name, fn) => _state.tracer.startActiveSpan(name, fn),
};

/**
 * Wraps `fn` in a named OTel span with optional attributes.
 * Works for both sync and async functions.
 */
export async function startSpan(name, attributes = {}, fn) {
  if (!fn) return undefined;
  return _state.tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [k, v] of Object.entries(attributes)) {
        span.setAttribute(k, v);
      }
      const result = await fn();
      span.setStatus({ code: _state.SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: _state.SpanStatusCode.ERROR, message: err.message });
      span.end();
      throw err;
    }
  });
}

/** Add attributes to the currently active span. No-op when disabled. */
export function addSpanAttributes(attrs) {
  _state.addSpanAttributes(attrs);
}

/** Record an error on the currently active span. No-op when disabled. */
export function recordSpanError(err) {
  _state.recordSpanError(err);
}

/** Returns the current trace ID as a hex string, or null when outside a trace. */
export function getTraceId() {
  return _state.getTraceId();
}

// ---------------------------------------------------------------------------
// #975 — Database query spans
// ---------------------------------------------------------------------------

/**
 * Wrap a database operation in a span.
 *
 * @param {string}   label      – human-readable query label (e.g. "getEarningsHistory")
 * @param {object}   [attrs]    – extra span attributes (e.g. { "db.table": "earnings" })
 * @param {Function} fn         – async () => result
 * @returns {Promise<*>}
 *
 * @example
 *   const rows = await wrapDbQuery("getContributorContracts", { "db.wallet": addr }, () =>
 *     db.prepare("SELECT …").all(addr)
 *   );
 */
export async function wrapDbQuery(label, attrs = {}, fn) {
  return startSpan(
    `db.query.${label}`,
    {
      "db.system":    "sqlite",
      "db.operation": label,
      ...attrs,
    },
    fn
  );
}

// ---------------------------------------------------------------------------
// #975 — Soroban contract execution spans
// ---------------------------------------------------------------------------

/**
 * Wrap a Soroban contract call in a span.
 *
 * @param {string}   contractId
 * @param {string}   method
 * @param {object}   [attrs]   – additional attributes
 * @param {Function} fn        – async () => result
 * @returns {Promise<*>}
 *
 * @example
 *   const xdr = await wrapContractCall(contractId, "distribute", {}, () =>
 *     buildTx(callerAddress, contractId, "distribute", args)
 *   );
 */
export async function wrapContractCall(contractId, method, attrs = {}, fn) {
  return startSpan(
    `soroban.contract.${method}`,
    {
      "stellar.contract_id": contractId,
      "stellar.method":      method,
      "rpc.system":          "soroban",
      ...attrs,
    },
    fn
  );
}

// ---------------------------------------------------------------------------
// #975 — RPC call spans
// ---------------------------------------------------------------------------

/**
 * Wrap an RPC call (Horizon or Soroban) in a span.
 *
 * @param {string}   label  – e.g. "horizon.getAccount", "soroban.simulateTransaction"
 * @param {string}   url    – endpoint URL (for observability)
 * @param {object}   [attrs]
 * @param {Function} fn
 * @returns {Promise<*>}
 */
export async function wrapRpcCall(label, url, attrs = {}, fn) {
  return startSpan(
    `rpc.${label}`,
    {
      "rpc.label":  label,
      "rpc.url":    url,
      "rpc.system": label.startsWith("horizon") ? "horizon" : "soroban",
      ...attrs,
    },
    fn
  );
}

// ---------------------------------------------------------------------------
// Express tracing middleware (unchanged + #975 enhancements)
// ---------------------------------------------------------------------------

export function tracingMiddleware(req, res, next) {
  const correlationId =
    req.headers?.["x-correlation-id"] ??
    getTraceId() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  req.correlationId = correlationId;
  res.setHeader?.("X-Correlation-Id", correlationId);

  if (!ENABLED) {
    next();
    return;
  }

  const otel = _state.getOtelModules();
  if (!otel) {
    next();
    return;
  }

  const { contextModule, propagationModule } = otel;

  // Extract W3C traceparent / tracestate from request headers
  // This links the frontend span to the backend span (end-to-end propagation)
  const parentContext = propagationModule.extract(contextModule.active(), req.headers);

  contextModule.with(parentContext, () => {
    _state.tracer.startActiveSpan(`${req.method} ${req.path}`, (span) => {
      span.setAttribute("http.method",       req.method);
      span.setAttribute("http.url",          req.originalUrl);
      span.setAttribute("http.route",        req.path);
      span.setAttribute("correlation_id",    correlationId);
      span.setAttribute("service.layer",     "backend-http");

      // #975: propagate trace context to outbound requests via res.locals
      // so downstream Stellar/Horizon calls can inject the traceparent header
      const traceId = getTraceId();
      if (traceId) {
        res.setHeader("X-Trace-Id", traceId);
        res.locals.traceId = traceId;
      }

      res.on("finish", () => {
        span.setAttribute("http.status_code", res.statusCode);
        span.setAttribute("http.response_content_length",
          parseInt(res.getHeader("content-length") ?? "0", 10) || 0
        );
        if (res.statusCode >= 500) {
          span.setStatus({
            code:    _state.SpanStatusCode.ERROR,
            message: `HTTP ${res.statusCode}`,
          });
        } else {
          span.setStatus({ code: _state.SpanStatusCode.OK });
        }
        span.end();
      });

      next();
    });
  });
}

// ---------------------------------------------------------------------------
// APM backend configuration helpers (#975)
// ---------------------------------------------------------------------------

/**
 * Build the OTLP exporter URL based on the selected APM backend.
 *
 * Supported backends:
 *   datadog  – sends to Datadog Agent OTLP receiver (default port 4318)
 *   newrelic – sends to New Relic OTLP endpoint
 *   jaeger   – sends to Jaeger OTLP receiver
 *   otlp     – generic OTLP/HTTP (default)
 */
function resolveExporterConfig() {
  const backend = (process.env.OTEL_APM_BACKEND ?? "otlp").toLowerCase();

  if (backend === "datadog") {
    const site   = process.env.DD_SITE ?? "datadoghq.com";
    const apiKey = process.env.DD_API_KEY;
    if (!apiKey) {
      console.warn("[tracing] OTEL_APM_BACKEND=datadog but DD_API_KEY is not set");
    }
    return {
      backend,
      // Datadog Agent OTLP receiver (local agent forwards to DD cloud)
      url:     process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
      headers: apiKey ? { "DD-API-KEY": apiKey } : {},
    };
  }

  if (backend === "newrelic") {
    const licenseKey = process.env.NEW_RELIC_LICENSE_KEY;
    if (!licenseKey) {
      console.warn("[tracing] OTEL_APM_BACKEND=newrelic but NEW_RELIC_LICENSE_KEY is not set");
    }
    return {
      backend,
      url:     "https://otlp.nr-data.net/v1/traces",
      headers: licenseKey ? { "api-key": licenseKey } : {},
    };
  }

  if (backend === "jaeger") {
    const endpoint =
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      process.env.JAEGER_ENDPOINT ??
      "http://localhost:4318";
    return {
      backend,
      url:     `${endpoint.replace(/\/$/, "")}/v1/traces`,
      headers: {},
    };
  }

  // Default: generic OTLP/HTTP
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    process.env.JAEGER_ENDPOINT ??
    "http://localhost:4318";
  return {
    backend: "otlp",
    url:     `${endpoint.replace(/\/$/, "")}/v1/traces`,
    headers: {},
  };
}

// ---------------------------------------------------------------------------
// Real OTel SDK initialisation (only when OTEL_ENABLED=true)
// ---------------------------------------------------------------------------

if (ENABLED) {
  Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
    import("@opentelemetry/api"),
  ])
    .then(
      ([
        { NodeSDK },
        { OTLPTraceExporter },
        { Resource },
        { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION },
        { trace, context, propagation, SpanStatusCode },
      ]) => {
        const serviceName    = process.env.OTEL_SERVICE_NAME    ?? "stellar-royalty-splitter";
        const serviceVersion = process.env.OTEL_SERVICE_VERSION ?? "unknown";

        const exporterConfig = resolveExporterConfig();

        console.info(
          `[tracing] Initialising OTel — backend: ${exporterConfig.backend}, endpoint: ${exporterConfig.url}`
        );

        const exporter = new OTLPTraceExporter({
          url:     exporterConfig.url,
          headers: exporterConfig.headers,
        });

        const sdk = new NodeSDK({
          resource: new Resource({
            [SEMRESATTRS_SERVICE_NAME]:    serviceName,
            [SEMRESATTRS_SERVICE_VERSION]: serviceVersion,
          }),
          traceExporter: exporter,
        });

        sdk.start();

        // Swap no-op state for real OTel implementations
        _state.tracer        = trace.getTracer(serviceName);
        _state.SpanStatusCode = SpanStatusCode;

        _state.getTraceId = () => {
          const span = trace.getActiveSpan();
          if (!span) return null;
          const id = span.spanContext().traceId;
          return id === "00000000000000000000000000000000" ? null : id;
        };

        _state.addSpanAttributes = (attrs) => {
          const span = trace.getActiveSpan();
          if (!span) return;
          for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
        };

        _state.recordSpanError = (err) => {
          const span = trace.getActiveSpan();
          if (!span) return;
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
        };

        _state.getOtelModules = () => ({
          contextModule:     context,
          propagationModule: propagation,
        });

        process.once("beforeExit", () => sdk.shutdown().catch(noop));
      }
    )
    .catch((err) => {
      console.warn(
        "OpenTelemetry packages not available, tracing disabled:",
        err.message
      );
    });
}
