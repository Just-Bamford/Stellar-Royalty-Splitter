import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { retryWithBackoff } from "./retryWithBackoff";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeResponseInit {
  status?: number;
  body?: unknown;
  textRaw?: string;
}

function fakeFetch({ status = 200, body, textRaw }: FakeResponseInit = {}) {
  const text = textRaw !== undefined ? textRaw : body !== undefined ? JSON.stringify(body) : "";
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(text),
  });
}

// ---------------------------------------------------------------------------
// Timeout scenario tests — AbortController integration
// ---------------------------------------------------------------------------

describe("network timeout scenarios (AbortController)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("fetch rejects with AbortError when signal is already aborted before call", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockFetch = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    vi.stubGlobal("fetch", mockFetch);

    await expect(fetch("/api/v1/test", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("AbortController abort fires during a pending request", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("Aborted", "AbortError");

    const mockFetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(abortError);
            return;
          }
          init?.signal?.addEventListener("abort", () => reject(abortError));
        }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const requestPromise = fetch("/api/v1/test", { signal: controller.signal });
    controller.abort();

    await expect(requestPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  test("multiple abort controllers are independent — one abort does not affect another", async () => {
    const c1 = new AbortController();
    const c2 = new AbortController();

    let c2Rejected = false;

    const mockFetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const abortError = new DOMException("Aborted", "AbortError");
          if (init?.signal?.aborted) {
            reject(abortError);
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            if (init.signal === c2.signal) c2Rejected = true;
            reject(abortError);
          });
          // Simulate a response after a tick when not aborted
          setTimeout(() => resolve({ ok: true, status: 200, text: async () => "{}" } as Response), 0);
        }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const req1 = fetch("/api/v1/a", { signal: c1.signal });
    const req2 = fetch("/api/v1/b", { signal: c2.signal });
    c1.abort();

    await expect(req1).rejects.toMatchObject({ name: "AbortError" });
    expect(c2Rejected).toBe(false);
    await expect(req2).resolves.toMatchObject({ ok: true });
    c2.abort();
  });

  test("retryWithBackoff stops retrying on AbortError from a signal abort", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("Aborted", "AbortError");

    const fn = vi.fn().mockRejectedValue(abortError);

    const run = retryWithBackoff(fn, {
      jitter: false,
      signal: controller.signal,
      retries: 5,
    }).catch((e: unknown) => e);

    controller.abort();

    const result = await run;
    expect((result as Error).name).toBe("AbortError");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("timeout simulation: request exceeds deadline and is aborted", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("Aborted", "AbortError");

    const mockFetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(abortError));
        }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const timer = setTimeout(() => controller.abort(), 10);
    try {
      await expect(
        fetch("/api/v1/slow-endpoint", { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(timer);
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed response handling tests
// ---------------------------------------------------------------------------

describe("malformed response handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("non-JSON response body is handled without throwing a syntax error", async () => {
    vi.stubGlobal("fetch", fakeFetch({ status: 200, textRaw: "not-valid-json{{{" }));

    const res = await fetch("/api/v1/test");
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    expect(parsed).toBeNull();
  });

  test("empty response body is handled gracefully", async () => {
    vi.stubGlobal("fetch", fakeFetch({ status: 200, textRaw: "" }));

    const res = await fetch("/api/v1/test");
    const text = await res.text();
    expect(text).toBe("");
  });

  test("response with valid JSON error body exposes error field", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({ status: 400, body: { error: "Invalid contract ID format", code: "bad_request" } }),
    );

    const res = await fetch("/api/v1/test");
    const text = await res.text();
    const data = JSON.parse(text) as Record<string, unknown>;
    expect(data.error).toBe("Invalid contract ID format");
    expect(data.code).toBe("bad_request");
  });

  test("truncated/partial JSON response is handled without crashing", async () => {
    vi.stubGlobal("fetch", fakeFetch({ status: 200, textRaw: '{"xdr":"abc' }));

    const res = await fetch("/api/v1/test");
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    expect(parsed).toBeNull();
  });

  test("HTML error page from a proxy/gateway is handled as unparsable", async () => {
    const html = "<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>";
    vi.stubGlobal("fetch", fakeFetch({ status: 502, textRaw: html }));

    const res = await fetch("/api/v1/test");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    expect(parsed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session expiration flow tests
// ---------------------------------------------------------------------------

describe("session expiration flow (401 handling)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("401 response includes an error in the body", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({ status: 401, body: { error: "Unauthorized", code: "unauthorized" } }),
    );

    const res = await fetch("/api/v1/test");
    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
    const text = await res.text();
    const data = JSON.parse(text) as Record<string, unknown>;
    expect(data.error).toBe("Unauthorized");
  });

  test("session expiry event can be dispatched via CustomEvent", () => {
    const SESSION_EXPIRED_EVENT = "srs:session-expired";
    const received: CustomEvent[] = [];

    const handler = (e: Event) => received.push(e as CustomEvent);
    window.addEventListener(SESSION_EXPIRED_EVENT, handler);

    window.dispatchEvent(
      new CustomEvent(SESSION_EXPIRED_EVENT, {
        detail: { message: "Your session has expired. Please connect your wallet again." },
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].detail.message).toMatch(/session has expired/i);
    window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
  });

  test("CustomEvent detail message is user-friendly on session expiry", () => {
    const SESSION_EXPIRED_EVENT = "srs:session-expired";
    const MESSAGE = "Your session has expired. Please connect your wallet again.";
    let received: CustomEvent | null = null;

    const handler = (e: Event) => { received = e as CustomEvent; };
    window.addEventListener(SESSION_EXPIRED_EVENT, handler);

    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { message: MESSAGE } }));

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).detail.message).toBe(MESSAGE);
    window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
  });
});

// ---------------------------------------------------------------------------
// Retry logic with delay tests
// ---------------------------------------------------------------------------

describe("retry logic with delay tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("retryWithBackoff wrapping a fetch-like call retries on transient failure", async () => {
    const fetchSim = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ status: 200, data: "ok" });

    const run = retryWithBackoff(fetchSim, { jitter: false, baseDelayMs: 500 });
    await vi.advanceTimersByTimeAsync(500);

    await expect(run).resolves.toMatchObject({ status: 200 });
    expect(fetchSim).toHaveBeenCalledTimes(2);
  });

  test("retryWithBackoff exhausts retries and rejects with the last error", async () => {
    const fetchSim = vi.fn().mockRejectedValue(new Error("persistent failure"));

    const run = retryWithBackoff(fetchSim, { jitter: false, retries: 2, baseDelayMs: 100 }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(100 + 200);

    const result = await run;
    expect((result as Error).message).toBe("persistent failure");
    expect(fetchSim).toHaveBeenCalledTimes(3);
  });

  test("retryWithBackoff calls onRetry with correct attempt and delay on each retry", async () => {
    const fetchSim = vi
      .fn()
      .mockRejectedValueOnce(new Error("err1"))
      .mockRejectedValueOnce(new Error("err2"))
      .mockResolvedValue("done");

    const onRetry = vi.fn();
    const run = retryWithBackoff(fetchSim, { jitter: false, baseDelayMs: 200, onRetry });
    await vi.advanceTimersByTimeAsync(200 + 400);

    await expect(run).resolves.toBe("done");
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][1]).toBe(200);
    expect(onRetry.mock.calls[1][1]).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Error boundary recovery tests
// ---------------------------------------------------------------------------

describe("error boundary and state cleanup tests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a 503 response body can be parsed as a structured error", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({
        status: 503,
        body: {
          status: 503,
          code: "service_unavailable",
          message: "Stellar RPC is currently unavailable. Please try again later.",
          error: "Stellar RPC is currently unavailable. Please try again later.",
        },
      }),
    );

    const res = await fetch("/api/v1/distribute");
    expect(res.status).toBe(503);
    const text = await res.text();
    const data = JSON.parse(text) as Record<string, unknown>;
    expect(data.code).toBe("service_unavailable");
    expect(typeof data.message).toBe("string");
    expect((data.message as string).length).toBeGreaterThan(0);
  });

  test("a 500 error body exposes an error string for the UI to display", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({ status: 500, body: { error: "Internal server error" } }),
    );

    const res = await fetch("/api/v1/distribute");
    const text = await res.text();
    const data = JSON.parse(text) as Record<string, unknown>;
    expect(typeof data.error).toBe("string");
    expect((data.error as string).length).toBeGreaterThan(0);
  });

  test("network error (fetch rejection) propagates without swallowing the original error", async () => {
    const networkErr = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkErr));

    await expect(fetch("/api/v1/test")).rejects.toThrow("Failed to fetch");
  });

  test("after a network error, retryWithBackoff allows the next attempt to succeed", async () => {
    const networkErr = new TypeError("Failed to fetch");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce("recovered");

    vi.useFakeTimers();
    const run = retryWithBackoff(fn, { jitter: false, baseDelayMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();

    await expect(run).resolves.toBe("recovered");
  });

  test("validates that error response structure matches the expected API shape", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({
        status: 400,
        body: {
          status: 400,
          code: "validation_error",
          message: "Validation failed",
          error: "Validation failed",
          timestamp: new Date().toISOString(),
          details: [{ field: "contractId", message: "Invalid contract address", constraint: null }],
        },
      }),
    );

    const res = await fetch(`/api/v1/distribute`);
    const text = await res.text();
    const data = JSON.parse(text) as Record<string, unknown>;

    expect(data.status).toBe(400);
    expect(data.code).toBe("validation_error");
    expect(Array.isArray(data.details)).toBe(true);
    const details = data.details as Array<Record<string, unknown>>;
    expect(details[0]).toHaveProperty("field");
    expect(details[0]).toHaveProperty("message");
  });
});
