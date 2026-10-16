/** 权限点：与 docs/ERP_权限矩阵_v1.0.md 一致。
 * 前端只用它控制按钮显隐；后端仍会二次鉴权，隐藏菜单不构成权限控制。 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ACCESS_TOKEN_KEY, changePassword as changePasswordApi, currentDevUser, currentUser as currentUserApi, login as loginApi, logout as logoutApi, setDevUser as persistDevUser } from "../api/client";

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
  "deposit.post",
  "finance.transfer",
  "policy.manage",
  "policy.approve",
  "field-definition.manage",
  "audit.read",
  "pool.manage",
  "order-type.manage",
  "report.read",
  "import.manage",
  "user.manage",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

/** 角色 → 权限点。导出仅供测试与权限矩阵校验使用；运行时请走 useSession().can。 */
export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
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
    "report.read",
  ],
  finance: [
    "finance.read",
    "deposit.post",
    "finance.transfer",
    "customer.read",
    "counterparty.read",
    "order.event.post",
    "report.read",
  ],
  auditor: ["finance.read", "order.exception.approve", "policy.approve", "counterparty.read", "report.read"],
  viewer: ["finance.read", "report.read"],
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
  authenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  mustChangePassword: boolean;
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<string>(currentDevUser());
  // DEV 态默认视为已登录（X-Dev-User 直通、本地无 token）；显式点「退出登录」后
  // 回落 false 落登录页，刷新页面即恢复直通——开发态不会被关在登录页外。
  const [authenticated, setAuthenticated] = useState<boolean>(() => import.meta.env.DEV || Boolean(localStorage.getItem(ACCESS_TOKEN_KEY)));
  const [mustChangePassword, setMustChangePassword] = useState(false);
  useEffect(() => {
    if (!localStorage.getItem(ACCESS_TOKEN_KEY)) return;
    void currentUserApi().then((current) => {
      setUser(current.role.toLowerCase());
      setMustChangePassword(Boolean(current.must_change_password));
    }).catch(() => { localStorage.removeItem(ACCESS_TOKEN_KEY); setAuthenticated(false); });
  }, []);
  const switchUser = useCallback((next: string) => {
    persistDevUser(next);
    setUser(next);
  }, []);
  const login = useCallback(async (username: string, password: string) => {
    const loggedIn = await loginApi(username, password);
    setUser(loggedIn.role.toLowerCase());
    setMustChangePassword(Boolean(loggedIn.must_change_password));
    setAuthenticated(true);
  }, []);
  const changePassword = useCallback(async (oldPassword: string, newPassword: string) => {
    await changePasswordApi(oldPassword, newPassword);
    setMustChangePassword(false);
  }, []);
  const logout = useCallback(async () => {
    await logoutApi();
    setAuthenticated(false);
    setMustChangePassword(false);
  }, []);
  const value = useMemo<SessionValue>(() => {
    const permissions = new Set<string>(ROLE_PERMISSIONS[user] ?? []);
    return { user, permissions, can: (code: string) => permissions.has(code), switchUser, authenticated, mustChangePassword, changePassword, login, logout };
  }, [user, switchUser, authenticated, mustChangePassword, changePassword, login, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession 必须在 SessionProvider 内使用");
  return ctx;
}
