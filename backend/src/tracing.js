/**
 * Basic in-memory OpenTelemetry-like tracing system (#481)
 */

export const spans = [];

export function startSpan(name, correlationId) {
  const span = {
    id: Math.random().toString(36).substring(2, 15),
    traceId: correlationId || "unknown",
    name,
    startTime: Date.now(),
    endTime: null,
    attributes: {},
    events: [],
    end: function () {
      this.endTime = Date.now();
      spans.push(this);
      // Limit to 1000 spans in memory
      if (spans.length > 1000) {
        spans.shift();
      }
    },
    setAttribute: function (key, value) {
      this.attributes[key] = value;
      return this;
    },
    addEvent: function (name, attributes = {}) {
      this.events.push({ name, time: Date.now(), attributes });
      return this;
    },
  };
  return span;
}

export function getTraces(correlationId) {
  return spans.filter((s) => s.traceId === correlationId);
}
