import { PERMISSIONS, ROLE_PERMISSIONS, isKnownPermission, isValidExpiration, resolveEffectivePermissions } from "../src/models/rbac.js";

describe("advanced RBAC matrix", () => {
  test.each(["admin", "editor", "accountant", "viewer", "approver"])("%s has a defined permission set", (role) => {
    expect(ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
  });
  test("admin has every permission", () => expect(new Set(ROLE_PERMISSIONS.admin)).toEqual(new Set(Object.values(PERMISSIONS))));
  test("unknown roles and permissions fail safely", () => {
    expect(resolveEffectivePermissions(["unknown"])).toEqual(new Set());
    expect(isKnownPermission("root:all")).toBe(false);
  });
  test("multiple roles combine permissions", () => {
    const permissions = resolveEffectivePermissions(["editor", "accountant"]);
    expect(permissions).toContain(PERMISSIONS.SETTINGS_UPDATE);
    expect(permissions).toContain(PERMISSIONS.FINANCIALS_EXPORT);
  });
  test("active temporary permissions grant access and expired/revoked grants do not", () => {
    const now = Date.now();
    const permissions = resolveEffectivePermissions([], [
      { permission: PERMISSIONS.DISPUTES_APPROVE, expiresAt: new Date(now + 60_000).toISOString() },
      { permission: PERMISSIONS.FINANCIALS_EXPORT, expiresAt: new Date(now - 60_000).toISOString() },
      { permission: PERMISSIONS.SETTINGS_UPDATE, expiresAt: new Date(now + 60_000).toISOString(), revokedAt: new Date().toISOString() },
    ], now);
    expect(permissions).toEqual(new Set([PERMISSIONS.DISPUTES_APPROVE]));
  });
  test("expiration must be a future timestamp", () => {
    expect(isValidExpiration("not-a-date")).toBe(false);
    expect(isValidExpiration(new Date(Date.now() - 1).toISOString())).toBe(false);
    expect(isValidExpiration(new Date(Date.now() + 60_000).toISOString())).toBe(true);
  });
});
