import { describe, test, expect, beforeEach } from "@jest/globals";
import { startSpan, getTraces, spans } from "../src/tracing.js";

describe("Distributed Tracing (#481)", () => {
  beforeEach(() => {
    spans.length = 0; // Clear memory array
  });

  test("Initializes span with traceId", () => {
    const span = startSpan("GET /test", "123-abc");
    span.end();
    expect(spans).toHaveLength(1);
    expect(spans[0].traceId).toBe("123-abc");
  });

  test("Records attributes and events", () => {
    const span = startSpan("POST /test", "123-abc");
    span.setAttribute("http.method", "POST");
    span.addEvent("Auth checked");
    span.end();

    expect(spans[0].attributes["http.method"]).toBe("POST");
    expect(spans[0].events).toHaveLength(1);
    expect(spans[0].events[0].name).toBe("Auth checked");
  });

  test("getTraces retrieves traces by correlationId", () => {
    startSpan("A", "c-1").end();
    startSpan("B", "c-2").end();
    startSpan("C", "c-1").end();

    const result = getTraces("c-1");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("A");
    expect(result[1].name).toBe("C");
  });

  test("Memory leak prevention caps at 1000 spans", () => {
    for (let i = 0; i < 1005; i++) {
      startSpan(`Span ${i}`, "c-1").end();
    }
    expect(spans).toHaveLength(1000);
    expect(spans[0].name).toBe("Span 5"); // 0-4 were shifted
  });
});
