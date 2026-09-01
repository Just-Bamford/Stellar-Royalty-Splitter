/**
 * OpenTelemetry distributed tracing setup (#785).
 *
 * Initializes the OTel Node SDK with:
 *  - OTLP/HTTP trace exporter (Jaeger-compatible, configurable via OTEL_EXPORTER_OTLP_ENDPOINT)
 *  - W3C TraceContext propagator for frontend→backend→RPC trace linkage
 *  - Service name from OTEL_SERVICE_NAME (default: "stellar-royalty-splitter")
 *
 * Set OTEL_ENABLED=true to activate tracing (no-op by default so existing tests pass).
 *
 * Environment variables:
 *   OTEL_ENABLED                 - "true" to activate (default: "false")
 *   OTEL_SERVICE_NAME            - service name in traces (default: "stellar-royalty-splitter")
 *   OTEL_EXPORTER_OTLP_ENDPOINT  - exporter URL (default: "http://localhost:4318")
 *   JAEGER_ENDPOINT              - alias for OTEL_EXPORTER_OTLP_ENDPOINT (legacy)
 */

const ENABLED = process.env.OTEL_ENABLED === "true";

// ---------------------------------------------------------------------------
// No-op shims — always exported at module evaluation time so the module is
// safely importable regardless of whether OTel packages are installed.
// When OTEL_ENABLED=true the async SDK init below overwrites the mutable
// _state bucket and the exported functions delegate through it.
// ---------------------------------------------------------------------------

const noop = () => {};
const noopSpan = {
  setAttribute: noop,
  setStatus: noop,
  recordException: noop,
  end: noop,
};

// Mutable state bucket — lets the async SDK init swap in real implementations
// after the module has already been imported by other modules.
const _state = {
  tracer: {
    startActiveSpan: (_name, fn) => fn(noopSpan),
  },
  getTraceId: () => null,
  addSpanAttributes: noop,
  recordSpanError: noop,
  // Returns { contextModule, propagationModule } when SDK is ready, null otherwise.
  getOtelModules: () => null,
  SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** OTel tracer (or no-op shim). */
export const tracer = {
  startActiveSpan: (name, fn) => _state.tracer.startActiveSpan(name, fn),
};

/**
 * Wraps `fn` in an OTel span named `name` with the given `attributes`.
 * Returns whatever `fn` returns (sync or async).
 */
export async function startSpan(name, attributes = {}, fn) {
  if (!fn) return undefined;
  return _state.tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [k, v] of Object.entries(attributes)) {
        span.setAttribute(k, v);
      }
      const result = await fn();
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

/** Adds attributes to the currently active span (no-op when disabled). */
export function addSpanAttributes(attrs) {
  _state.addSpanAttributes(attrs);
}

/** Records an error on the currently active span (no-op when disabled). */
export function recordSpanError(err) {
  _state.recordSpanError(err);
}

/** Returns the current trace ID as a hex string, or null when not in a trace. */
export function getTraceId() {
  return _state.getTraceId();
}

// ---------------------------------------------------------------------------
// Express tracing middleware
//
// Creates a root span per request, injects W3C traceparent context from
// incoming headers (frontend propagation), attaches http.* attributes, and
// writes X-Trace-Id / X-Correlation-Id response headers.
//
// Gracefully degrades to correlation-ID-only when tracing is disabled.
// ---------------------------------------------------------------------------

export function tracingMiddleware(req, res, next) {
  // Correlation ID: prefer explicit header, fall back to trace ID or a generated ID
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

  // When OTel is enabled _state.getOtelModules() returns the real
  // context + propagation APIs. If SDK init is still in-flight, fall through.
  const otel = _state.getOtelModules();
  if (!otel) {
    next();
    return;
  }

  const { contextModule, propagationModule } = otel;

  // Extract W3C traceparent / tracestate from incoming request headers
  const parentContext = propagationModule.extract(contextModule.active(), req.headers);

  contextModule.with(parentContext, () => {
    _state.tracer.startActiveSpan(`${req.method} ${req.path}`, (span) => {
      span.setAttribute("http.method", req.method);
      span.setAttribute("http.url", req.originalUrl);
      span.setAttribute("http.route", req.path);
      span.setAttribute("correlation_id", correlationId);

      const traceId = getTraceId();
      if (traceId) res.setHeader("X-Trace-Id", traceId);

      res.on("finish", () => {
        span.setAttribute("http.status_code", res.statusCode);
        if (res.statusCode >= 500) {
          span.setStatus({
            code: _state.SpanStatusCode.ERROR,
            message: `HTTP ${res.statusCode}`,
          });
        }
        span.end();
      });

      next();
    });
  });
}

// ---------------------------------------------------------------------------
// Real OTel SDK initialisation (only when OTEL_ENABLED=true).
// Uses dynamic import so the module is importable when packages are absent.
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
        { SEMRESATTRS_SERVICE_NAME },
        { trace, context, propagation, SpanStatusCode },
      ]) => {
        const endpoint =
          process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
          process.env.JAEGER_ENDPOINT ??
          "http://localhost:4318";

        const serviceName =
          process.env.OTEL_SERVICE_NAME ?? "stellar-royalty-splitter";

        const exporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });

        const sdk = new NodeSDK({
          resource: new Resource({ [SEMRESATTRS_SERVICE_NAME]: serviceName }),
          traceExporter: exporter,
        });

        sdk.start();

        // Swap no-op state for real OTel implementations
        _state.tracer = trace.getTracer(serviceName);
        _state.SpanStatusCode = SpanStatusCode;

        _state.getTraceId = () => {
          const span = trace.getActiveSpan();
          if (!span) return null;
          const id = span.spanContext().traceId;
          // All-zeros means "no active trace"
          return id === "00000000000000000000000000000000" ? null : id;
        };

        _state.addSpanAttributes = (attrs) => {
          const span = trace.getActiveSpan();
          if (!span) return;
          for (const [k, v] of Object.entries(attrs)) {
            span.setAttribute(k, v);
          }
        };

        _state.recordSpanError = (err) => {
          const span = trace.getActiveSpan();
          if (!span) return;
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
        };

        _state.getOtelModules = () => ({ contextModule: context, propagationModule: propagation });

        // Graceful shutdown alongside the app
        process.once("beforeExit", () => sdk.shutdown().catch(noop));
      }
    )
    .catch((err) => {
      // Packages not installed or SDK init failed — stay in no-op mode
      console.warn(
        "OpenTelemetry packages not available, tracing disabled:",
        err.message
      );
    });
}
