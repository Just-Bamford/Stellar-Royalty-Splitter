import { describe, it, expect } from "vitest";
import { sanitizeErrorMessage } from "./sanitize";

describe("sanitizeErrorMessage (#499 XSS)", () => {
  it("strips <script> tags and their body", () => {
    const out = sanitizeErrorMessage('Failed <script>alert("xss")</script>');
    expect(out).not.toContain("<");
    expect(out).not.toContain("script");
    expect(out).toBe("Failed");
  });

  it("removes img onerror payloads", () => {
    const out = sanitizeErrorMessage('<img src=x onerror="alert(1)">boom');
    expect(out).not.toMatch(/onerror|<img/i);
    expect(out).toBe("boom");
  });

  it("strips inline event-handler elements", () => {
    const out = sanitizeErrorMessage('<div onclick="steal()">click</div>');
    expect(out).not.toContain("onclick");
    expect(out).toBe("click");
  });

  it("neutralises stray angle brackets", () => {
    expect(sanitizeErrorMessage("amount <> balance")).not.toMatch(/[<>]/);
  });

  it("leaves a legitimate error message intact", () => {
    expect(sanitizeErrorMessage("Amount exceeds contract balance.")).toBe(
      "Amount exceeds contract balance.",
    );
  });
});
