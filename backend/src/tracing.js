/**
 * OpenTelemetry distributed tracing setup (#785, #975).
 *
 * Initializes the OTel Node SDK with:
 *  - OTLP/HTTP trace exporter (Jaeger-compatible, configurable via OTEL_EXPORTER_OTLP_ENDPOINT)
 *  - W3C TraceContext propagator for frontend→backend→contract→RPC trace linkage
 *  - Service name from OTEL_SERVICE_NAME (default: "stellar-royalty-splitter")
 *  - Enhanced instrumentation for database queries, HTTP clients, and custom spans
 *
 * Set OTEL_ENABLED=true to activate tracing (no-op by default so existing tests pass).
 *
 * Environment variables:
 *   OTEL_ENABLED                 - "true" to activate (default: "false")
 *   OTEL_SERVICE_NAME            - service name in traces (default: "stellar-royalty-splitter")
 *   OTEL_EXPORTER_OTLP_ENDPOINT  - exporter URL (default: "http://localhost:4318")
 *   JAEGER_ENDPOINT              - alias for OTEL_EXPORTER_OTLP_ENDPOINT (legacy)
 *   OTEL_SAMPLE_RATE             - sampling rate 0.0-1.0 (default: 1.0)
 */

const ENABLED = process.env.OTEL_ENABLED === "true";
const SAMPLE_RATE = parseFloat(process.env.OTEL_SAMPLE_RATE ?? "1.0");

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
  addEvent: noop,
};

// Mutable state bucket — lets the async SDK init swap in real implementations
// after the module has already been imported by other modules.
const _state = {
  tracer: {
    startActiveSpan: (_name, fn) => fn(noopSpan),
    startSpan: (_name) => noopSpan,
  },
  getTraceId: () => null,
  getSpanId: () => null,
  addSpanAttributes: noop,
  addSpanEvent: noop,
  recordSpanError: noop,
  // Returns { contextModule, propagationModule } when SDK is ready, null otherwise.
  getOtelModules: () => null,
  SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
  SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** OTel tracer (or no-op shim). */
export const tracer = {
  startActiveSpan: (name, fn) => _state.tracer.startActiveSpan(name, fn),
  startSpan: (name) => _state.tracer.startSpan(name),
};

/**
 * Wraps `fn` in an OTel span named `name` with the given `attributes`.
 * Returns whatever `fn` returns (sync or async).
 * Enhanced with error tracking and duration metrics.
 */
export async function startSpan(name, attributes = {}, fn) {
  if (!fn) return undefined;
  const startTime = Date.now();
  
  return _state.tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [k, v] of Object.entries(attributes)) {
        span.setAttribute(k, v);
      }
      span.setAttribute("span.start_time_ms", startTime);
      
      const result = await fn();
      
      const duration = Date.now() - startTime;
      span.setAttribute("span.duration_ms", duration);
      span.setStatus({ code: _state.SpanStatusCode.OK });
      span.end();
      
      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      span.setAttribute("span.duration_ms", duration);
      span.setAttribute("error.type", err.constructor.name);
      span.setAttribute("error.message", err.message);
      span.setAttribute("error.stack", err.stack);
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

/** Adds an event to the currently active span (no-op when disabled). */
export function addSpanEvent(name, attributes = {}) {
  _state.addSpanEvent(name, attributes);
}

/** Records an error on the currently active span (no-op when disabled). */
export function recordSpanError(err) {
  _state.recordSpanError(err);
}

/** Returns the current trace ID as a hex string, or null when not in a trace. */
export function getTraceId() {
  return _state.getTraceId();
}

/** Returns the current span ID as a hex string, or null when not in a span. */
export function getSpanId() {
  return _state.getSpanId();
}

/**
 * Trace a database query operation
 * Adds db.* semantic conventions
 */
export async function traceDatabase(operation, query, fn) {
  return startSpan(`db.${operation}`, {
    "db.system": "sqlite",
    "db.operation": operation,
    "db.statement": query?.substring(0, 500), // Truncate for safety
  }, fn);
}

/**
 * Trace an HTTP client request
 * Adds http.* semantic conventions
 */
export async function traceHttpClient(method, url, fn) {
  return startSpan(`http.client.${method}`, {
    "http.method": method,
    "http.url": url,
    "http.scheme": new URL(url).protocol.replace(":", ""),
    "http.target": new URL(url).pathname,
    "span.kind": "client",
  }, fn);
}

/**
 * Trace a contract operation (Soroban RPC call)
 * Adds contract.* semantic conventions
 */
export async function traceContract(operation, contractId, fn) {
  return startSpan(`contract.${operation}`, {
    "contract.id": contractId,
    "contract.operation": operation,
    "blockchain.network": process.env.STELLAR_NETWORK ?? "public",
  }, fn);
}

// ---------------------------------------------------------------------------
// Express tracing middleware
//
// Creates a root span per request, injects W3C traceparent context from
// incoming headers (frontend propagation), attaches http.* attributes, and
// writes X-Trace-Id / X-Correlation-Id / X-Span-Id response headers.
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
      // Enhanced HTTP semantic conventions
      span.setAttribute("http.method", req.method);
      span.setAttribute("http.url", req.originalUrl);
      span.setAttribute("http.route", req.path);
      span.setAttribute("http.scheme", req.protocol);
      span.setAttribute("http.target", req.originalUrl);
      span.setAttribute("http.host", req.get("host") || "unknown");
      span.setAttribute("http.user_agent", req.get("user-agent") || "unknown");
      span.setAttribute("http.request_content_length", req.get("content-length") || "0");
      span.setAttribute("correlation_id", correlationId);
      span.setAttribute("client.address", req.ip || req.socket.remoteAddress);
      
      // Add API key if present (but not the actual value)
      if (req.headers["x-api-key"]) {
        span.setAttribute("http.api_key_present", "true");
      }

      const traceId = getTraceId();
      const spanId = getSpanId();
      if (traceId) res.setHeader("X-Trace-Id", traceId);
      if (spanId) res.setHeader("X-Span-Id", spanId);

      // Track response
      const startTime = Date.now();
      
      res.on("finish", () => {
        const duration = Date.now() - startTime;
        span.setAttribute("http.status_code", res.statusCode);
        span.setAttribute("http.response_content_length", res.get("content-length") || "0");
        span.setAttribute("http.response_time_ms", duration);
        
        if (res.statusCode >= 500) {
          span.setStatus({
            code: _state.SpanStatusCode.ERROR,
            message: `HTTP ${res.statusCode}`,
          });
        } else if (res.statusCode >= 400) {
          span.setStatus({
            code: _state.SpanStatusCode.ERROR,
            message: `HTTP ${res.statusCode}`,
          });
        } else {
          span.setStatus({ code: _state.SpanStatusCode.OK });
        }
        
        span.end();
      });

      res.on("error", (err) => {
        span.recordException(err);
        span.setStatus({
          code: _state.SpanStatusCode.ERROR,
          message: err.message,
        });
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
        { trace, context, propagation, SpanStatusCode, SpanKind },
      ]) => {
        const endpoint =
          process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
          process.env.JAEGER_ENDPOINT ??
          "http://localhost:4318";

        const serviceName =
          process.env.OTEL_SERVICE_NAME ?? "stellar-royalty-splitter";

        const exporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });

        // Configure sampling based on OTEL_SAMPLE_RATE
        const samplerConfig = SAMPLE_RATE < 1.0 ? {
          sampler: {
            shouldSample: () => {
              return Math.random() < SAMPLE_RATE 
                ? { decision: 1 } // RECORD_AND_SAMPLE
                : { decision: 0 }; // DROP
            },
          },
        } : {};

        const sdk = new NodeSDK({
          resource: new Resource({ 
            [SEMRESATTRS_SERVICE_NAME]: serviceName,
            "service.version": process.env.npm_package_version ?? "unknown",
            "deployment.environment": process.env.NODE_ENV ?? "development",
          }),
          traceExporter: exporter,
          ...samplerConfig,
        });

        sdk.start();

        // Swap no-op state for real OTel implementations
        _state.tracer = trace.getTracer(serviceName);
        _state.SpanStatusCode = SpanStatusCode;
        _state.SpanKind = SpanKind;

        _state.getTraceId = () => {
          const span = trace.getActiveSpan();
          if (!span) return null;
          const id = span.spanContext().traceId;
          // All-zeros means "no active trace"
          return id === "00000000000000000000000000000000" ? null : id;
        };

        _state.getSpanId = () => {
          const span = trace.getActiveSpan();
          if (!span) return null;
          const id = span.spanContext().spanId;
          return id === "0000000000000000" ? null : id;
        };

        _state.addSpanAttributes = (attrs) => {
          const span = trace.getActiveSpan();
          if (!span) return;
          for (const [k, v] of Object.entries(attrs)) {
            span.setAttribute(k, v);
          }
        };

        _state.addSpanEvent = (name, attrs = {}) => {
          const span = trace.getActiveSpan();
          if (!span) return;
          span.addEvent(name, attrs);
        };

        _state.recordSpanError = (err) => {
          const span = trace.getActiveSpan();
          if (!span) return;
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
        };

        _state.getOtelModules = () => ({ contextModule: context, propagationModule: propagation });

        console.log(`OpenTelemetry tracing enabled: ${serviceName} -> ${endpoint} (sample rate: ${SAMPLE_RATE})`);

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
