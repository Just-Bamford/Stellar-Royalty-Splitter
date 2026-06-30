import { describe, test, expect } from "vitest";
import { generateRequestNonce } from "./request-nonce";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("generateRequestNonce (#421)", () => {
  test("returns a valid UUID v4 string", () => {
    expect(generateRequestNonce()).toMatch(UUID_V4_RE);
  });

  test("successive calls return different values", () => {
    const a = generateRequestNonce();
    const b = generateRequestNonce();
    expect(a).not.toBe(b);
  });
});
