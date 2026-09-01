import { useState, useEffect, useCallback } from "react";

export type Role = "viewer" | "collaborator" | "operator" | "admin";

const ROLE_ORDER: Record<Role, number> = {
  viewer: 0,
  collaborator: 1,
  operator: 2,
  admin: 3,
};

interface UseRoleResult {
  role: Role;
  loading: boolean;
  /** Returns true when the caller's role is >= minRole */
  hasPermission: (minRole: Role) => boolean;
  /** True when the caller can trigger distributions (#658) */
  canDistribute: boolean;
  /** True when the caller can manage contributors (#658) */
  canManageContributors: boolean;
  /** True when the caller has full admin access */
  isAdmin: boolean;
  reload: () => void;
}

export function useRole(apiKey?: string | null): UseRoleResult {
  const [role, setRole] = useState<Role>("viewer");
  const [loading, setLoading] = useState<boolean>(false);

  const fetchRole = useCallback(async () => {
    if (!apiKey) {
      setRole("viewer");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/admin/roles/me", {
        headers: { "x-api-key": apiKey },
      });
      if (res.ok) {
        const data = await res.json() as { role: string };
        const r = data.role as Role;
        if (r in ROLE_ORDER) {
          setRole(r);
        }
      }
    } catch {
      // network error — default to viewer (least privilege)
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    void fetchRole();
  }, [fetchRole]);

  const hasPermission = useCallback(
    (minRole: Role): boolean => ROLE_ORDER[role] >= ROLE_ORDER[minRole],
    [role],
  );

  return {
    role,
    loading,
    hasPermission,
    canDistribute: ROLE_ORDER[role] >= ROLE_ORDER.operator,
    canManageContributors: ROLE_ORDER[role] >= ROLE_ORDER.operator,
    isAdmin: role === "admin",
    reload: fetchRole,
  };
}
