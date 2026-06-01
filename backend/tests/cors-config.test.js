import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { isDevEnv, resolveCorsOrigin, validateCorsOrigin } from "../src/cors-config.js";

const ENV_KEYS = ["NODE_ENV", "FRONTEND_ORIGIN"];

let snapshot = {};

beforeEach(() => {
  snapshot = {};
  for (const k of ENV_KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("isDevEnv (#276)", () => {
  test("development/test count as dev", () => {
    expect(isDevEnv("development")).toBe(true);
    expect(isDevEnv("test")).toBe(true);
  });
  test("production / staging / falsy default to prod", () => {
    expect(isDevEnv("production")).toBe(false);
    expect(isDevEnv("staging")).toBe(false);
    expect(isDevEnv(undefined)).toBe(false);
    expect(isDevEnv("")).toBe(false);
  });
});

describe("validateCorsOrigin (#276)", () => {
  test("accepts a well-formed https URL in production", () => {
    expect(validateCorsOrigin("https://app.example.com", { dev: false })).toBe(
      "https://app.example.com"
    );
  });

  test("allows '*' in development", () => {
    expect(validateCorsOrigin("*", { dev: true })).toBe("*");
  });

  test("rejects '*' in production", () => {
    expect(() => validateCorsOrigin("*", { dev: false })).toThrow(
      /not allowed in production/
    );
  });

  test("rejects malformed URLs", () => {
    expect(() => validateCorsOrigin("not-a-url", { dev: false })).toThrow(
      /not a valid URL/
    );
  });

  test("rejects non-string / empty input", () => {
    expect(() => validateCorsOrigin("", { dev: true })).toThrow(/non-empty/);
    expect(() => validateCorsOrigin(undefined, { dev: true })).toThrow(/non-empty/);
  });

  test("rejects file:// / ftp:// etc.", () => {
    expect(() => validateCorsOrigin("file:///etc/passwd", { dev: false })).toThrow(
      /http or https/
    );
  });
});

describe("resolveCorsOrigin (#276)", () => {
  test("dev with no env var defaults to '*'", () => {
    expect(resolveCorsOrigin({ envOrigin: undefined, dev: true })).toBe("*");
  });

  test("production refuses to start without FRONTEND_ORIGIN", () => {
    expect(() => resolveCorsOrigin({ envOrigin: undefined, dev: false })).toThrow(
      /required in production/
    );
  });

  test("production honours an explicit FRONTEND_ORIGIN", () => {
    expect(
      resolveCorsOrigin({ envOrigin: "https://shade.example.com", dev: false })
    ).toBe("https://shade.example.com");
  });
});
