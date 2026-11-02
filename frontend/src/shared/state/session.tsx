/** 权限点：以后端 `core/security.py` 的 `PERM_*` 为唯一来源。
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
  "finance.read",
  "deposit.post",
  "finance.transfer",
  "finance.order.event.post",
    "policy.manage",
  "field-definition.manage",
  "audit.read",
  "pool.manage",
  "order-type.manage",
  "option-set.manage",
  "report.read",
  "report.export",
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
    "customer.contact.write",
    "counterparty.read",
    "order.create",
    "order.update",
    "order.event.post",
    "finance.read",
    "report.read",
    "report.export",
  ],
  finance: [
    "finance.read",
    "deposit.post",
    "finance.transfer",
    "finance.order.event.post",
        "customer.read",
    "customer.contact.read",
    "counterparty.read",
    "audit.read",
    "report.read",
    "report.export",
  ],
  auditor: [
    "finance.read",
    "customer.read",
    "customer.contact.read",
    "counterparty.read",
    "policy.manage",
    "audit.read",
    "report.read",
    "report.export",
  ],
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
    if (import.meta.env.DEV && username.trim().toLowerCase() === "admin" && !password) {
      persistDevUser("admin");
      setUser("admin");
      setMustChangePassword(false);
      setAuthenticated(true);
      return;
    }
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
    // 后端 /auth/logout 失败也必须退出本地会话：否则「退出登录」点了没反应，
    // 用户以为已退出却仍停留在已登录界面。
    try {
      await logoutApi();
    } catch {
      // 退出是本地会话的终止动作，不应被后端不可达阻断或产生未处理拒绝。
      // 服务端若可达会撤销 token；不可达时 finally 仍清理本地 token 并落登录页。
    } finally {
      setAuthenticated(false);
      setMustChangePassword(false);
    }
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
