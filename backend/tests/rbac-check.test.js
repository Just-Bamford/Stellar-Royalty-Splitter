import { jest } from "@jest/globals";
import { requirePermission } from "../src/middleware/rbac-check.js";
import { PERMISSIONS } from "../src/models/rbac.js";

function response() { return { statusCode: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
describe("permission middleware", () => {
  test("rejects missing users rather than treating them as viewers", () => {
    const res = response(); const next = jest.fn(); requirePermission(PERMISSIONS.AUDIT_READ)({}, res, next);
    expect(res.statusCode).toBe(401); expect(next).not.toHaveBeenCalled();
  });
  test("rejects unknown permissions at wiring time", () => expect(() => requirePermission("root:all")).toThrow(/Unknown/));
  test("accepts one-or-many permission declarations", () => {
    expect(() => requirePermission([PERMISSIONS.AUDIT_READ, PERMISSIONS.PERMISSIONS_READ])).not.toThrow();
  });
});
