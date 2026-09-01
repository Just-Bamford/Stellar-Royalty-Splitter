/**
 * OWASP A01:2021 — Broken Access Control
 *
 * Exercises the real RBAC middleware in src/middleware/rbac.js against the
 * documented role hierarchy (viewer < collaborator < operator < admin).
 *
 * Removing the `roleIndex >= minIndex` comparison, or defaulting an unknown
 * caller to something above "viewer", makes these fail deterministically.
 */
import { jest } from "@jest/globals";
import { ROLES, requireRole } from "../../src/middleware/rbac.js";

function mockRes() {
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
  return res;
}

function run(middleware, req) {
  const res = mockRes();
  const next = jest.fn();
  middleware(req, res, next);
  return { res, next };
}

describe("Security — OWASP A01 Broken Access Control", () => {
  test("role hierarchy is ordered least- to most-privileged", () => {
    expect(ROLES).toEqual(["viewer", "collaborator", "operator", "admin"]);
  });

  describe("privilege escalation is refused", () => {
    // Every caller role that sits strictly below the required role.
    const escalations = [
      ["viewer", "collaborator"],
      ["viewer", "operator"],
      ["viewer", "admin"],
      ["collaborator", "operator"],
      ["collaborator", "admin"],
      ["operator", "admin"],
    ];

    test.each(escalations)(
      "%s cannot reach a %s-only route",
      (callerRole, requiredRole) => {
        const { res, next } = run(requireRole(requiredRole), {
          role: callerRole,
          originalUrl: "/api/v1/protected",
        });

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe("forbidden");
      }
    );
  });

  describe("legitimate access is allowed", () => {
    const allowed = [
      ["admin", "admin"],
      ["admin", "viewer"],
      ["operator", "collaborator"],
      ["collaborator", "collaborator"],
      ["viewer", "viewer"],
    ];

    test.each(allowed)("%s may reach a %s route", (callerRole, requiredRole) => {
      const { res, next } = run(requireRole(requiredRole), {
        role: callerRole,
        originalUrl: "/api/v1/protected",
      });

      expect(next).toHaveBeenCalled();
      expect(res.statusCode).toBeNull();
    });
  });

  describe("unauthenticated and forged roles fall back to least privilege", () => {
    test("a request with no role is treated as viewer", () => {
      const { res, next } = run(requireRole("admin"), {
        originalUrl: "/api/v1/admin",
      });
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    test.each([
      "superadmin",
      "root",
      "ADMIN",
      "admin ",
      "",
      "../admin",
      "administrator",
    ])("unknown role %j cannot satisfy requireRole('admin')", (role) => {
      const { res, next } = run(requireRole("admin"), {
        role,
        originalUrl: "/api/v1/admin",
      });
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    test("a non-string role cannot satisfy requireRole", () => {
      for (const role of [{ toString: () => "admin" }, ["admin"], 3, true]) {
        const { res, next } = run(requireRole("admin"), {
          role,
          originalUrl: "/api/v1/admin",
        });
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
      }
    });
  });

  test("requireRole refuses to build a guard for an unknown role", () => {
    // Fail closed at wiring time rather than silently allowing everyone.
    expect(() => requireRole("superadmin")).toThrow(/Unknown role/);
  });

  test("denial responses do not leak the required role or internals", () => {
    const { res } = run(requireRole("admin"), {
      role: "viewer",
      originalUrl: "/api/v1/admin/rotate-key",
    });

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/stack|sqlite|node_modules|ADMIN_ROTATE_TOKEN/i);
    expect(res.body.message).toBe("Insufficient permissions");
  });
});
