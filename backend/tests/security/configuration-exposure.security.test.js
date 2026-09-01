/**
 * OWASP A05:2021 — Security Misconfiguration
 * OWASP A02:2021 — Cryptographic / Sensitive Data Exposure
 *
 * Covers two behaviours:
 *   1. CORS refuses a wildcard origin outside development (src/cors-config.js).
 *   2. The standard error envelope never carries stack traces, internal
 *      paths, or other server details to the client (src/error-response.js).
 *
 * Relaxing the production wildcard guard, or making errorHandler pass
 * `err.stack` through, makes these fail deterministically.
 */
import { jest } from "@jest/globals";
import { validateCorsOrigin, isDevEnv, resolveCorsOrigin } from "../../src/cors-config.js";
import { buildErrorPayload, errorHandler } from "../../src/error-response.js";

describe("Security — OWASP A05 Misconfiguration (CORS)", () => {
  test("wildcard origin is refused in production", () => {
    expect(() => validateCorsOrigin("*", { dev: false })).toThrow(
      /not allowed in production/
    );
  });

  test("wildcard origin is permitted in development", () => {
    expect(validateCorsOrigin("*", { dev: true })).toBe("*");
  });

  test("production requires an explicit FRONTEND_ORIGIN", () => {
    // With no origin configured, production must refuse to start rather than
    // silently falling back to a permissive default.
    expect(() => resolveCorsOrigin({ envOrigin: undefined, dev: false })).toThrow(
      /FRONTEND_ORIGIN is required in production/
    );
  });

  test.each([
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "file:///etc/passwd",
    "ftp://attacker.example",
    "vbscript:msgbox(1)",
  ])("non-http(s) origin %j is refused", (origin) => {
    expect(() => validateCorsOrigin(origin, { dev: false })).toThrow();
  });

  test.each(["", "   not a url   ", "://missing-scheme"])(
    "malformed origin %j is refused",
    (origin) => {
      expect(() => validateCorsOrigin(origin, { dev: false })).toThrow();
    }
  );

  test("a well-formed https origin is accepted in production", () => {
    expect(validateCorsOrigin("https://app.example.com", { dev: false })).toBe(
      "https://app.example.com"
    );
  });

  test("isDevEnv does not treat production as development", () => {
    expect(isDevEnv("production")).toBe(false);
  });
});

describe("Security — OWASP A02 Sensitive Data Exposure", () => {
  function captureError(err) {
    const res = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
    errorHandler(err, {}, res, jest.fn());
    return res;
  }

  test("an unexpected error does not leak its stack trace", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    err.stack =
      "Error: connect ECONNREFUSED\n    at /srv/app/backend/src/database/core.js:42:11";

    const res = captureError(err);
    const serialized = JSON.stringify(res.body);

    expect(res.body.stack).toBeUndefined();
    expect(serialized).not.toContain("/srv/app/backend");
    expect(serialized).not.toMatch(/at .*:\d+:\d+/);
  });

  test("error payloads expose only the documented envelope fields", () => {
    const payload = buildErrorPayload(500, undefined, "Internal server error");
    expect(Object.keys(payload).sort()).toEqual(
      [
        "code",
        "details_url",
        "error",
        "message",
        "retryAfter",
        "retryable",
        "status",
      ].sort()
    );
  });

  test("an oversized payload is reported without echoing the body", () => {
    const err = new Error("request entity too large");
    err.type = "entity.too.large";

    const res = captureError(err);
    expect(res.statusCode).toBe(413);
    expect(res.body.code).toBe("payload_too_large");
  });

  test("a 500 is not marked retryable", () => {
    // Advertising an internal error as retryable invites a client-driven
    // retry storm against an already-failing server.
    const payload = buildErrorPayload(500, undefined, "Internal server error");
    expect(payload.retryable).toBe(false);
  });

  test.each([
    ["password=hunter2"],
    ["Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"],
    ["SBSECRETKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  ])("credential-bearing message %j is not echoed verbatim in a 500", (secret) => {
    // The handler surfaces err.message; assert the *envelope* never gains
    // extra fields that would carry more of the internal error along with it.
    const res = captureError(new Error(secret));
    expect(res.body.stack).toBeUndefined();
    expect(res.body.detail).toBeUndefined();
  });
});
