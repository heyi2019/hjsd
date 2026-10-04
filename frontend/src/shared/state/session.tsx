/** 权限点：与 docs/ERP_权限矩阵_v1.0.md 一致。
 * 前端只用它控制按钮显隐；后端仍会二次鉴权，隐藏菜单不构成权限控制。 */
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { currentDevUser, setDevUser as persistDevUser } from "../api/client";

export const ALL_PERMISSIONS = [
  "customer.read",
  "customer.contact.read",
  "customer.create",
  "customer.update",
  "customer.contact.write",
  "customer.merge",
  "counterparty.read",
  "counterparty.manage",
  "order.create",
  "order.update",
  "order.event.post",
  "order.exception.approve",
  "finance.read",
  "finance.transfer",
  "deposit.post",
  "policy.manage",
  "policy.approve",
  "field-definition.manage",
  "audit.read",
  "pool.manage",
  "order-type.manage",
  "quality.read",
  "quality.resolve",
  "report.read",
  "history.import",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  operator: [
    "customer.read",
    "customer.create",
    "customer.update",
    "customer.contact.read",
    "counterparty.read",
    "order.create",
    "order.update",
    "order.event.post",
    "finance.read",
    "quality.read",
    "report.read",
  ],
  finance: [
    "finance.read",
    "finance.transfer",
    "deposit.post",
    "customer.read",
    "counterparty.read",
    "order.event.post",
    "quality.read",
    "report.read",
  ],
  auditor: ["finance.read", "order.exception.approve", "policy.approve", "counterparty.read", "quality.read", "quality.resolve", "report.read"],
  viewer: ["finance.read", "quality.read", "report.read"],
};

export const DEV_ROLES: { value: string; label: string }[] = [
  { value: "admin", label: "系统管理员" },
  { value: "operator", label: "业务经办人" },
  { value: "finance", label: "财务" },
  { value: "auditor", label: "业务审核人" },
  { value: "viewer", label: "经营查看人" },
];

interface SessionValue {
  user: string;
  permissions: Set<string>;
  can: (code: string) => boolean;
  switchUser: (user: string) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<string>(currentDevUser());
  const switchUser = useCallback((next: string) => {
    persistDevUser(next);
    setUser(next);
  }, []);
  const value = useMemo<SessionValue>(() => {
    const permissions = new Set<string>(ROLE_PERMISSIONS[user] ?? []);
    return { user, permissions, can: (code: string) => permissions.has(code), switchUser };
  }, [user, switchUser]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession 必须在 SessionProvider 内使用");
  return ctx;
}
