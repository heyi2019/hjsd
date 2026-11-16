/** 权限点：以后端 `core/security.py` 的 `PERM_*` 为唯一来源。
 * 前端只用它控制按钮显隐；后端仍会二次鉴权，隐藏菜单不构成权限控制。 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ACCESS_TOKEN_KEY, changePassword as changePasswordApi, currentDevUser, currentUser as currentUserApi, login as loginApi, logout as logoutApi, setDevUser as persistDevUser } from "../api/client";

export const ALL_PERMISSIONS = [
  "customer.read",
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
    "counterparty.read",
    "audit.read",
    "report.read",
    "report.export",
  ],
  auditor: [
    "finance.read",
    "customer.read",
    "counterparty.read",
    "policy.manage",
    "audit.read",
    "report.read",
    "report.export",
  ],
  viewer: ["finance.read", "report.read"],
  // 普通员工：仅业务录入，不含 finance.read / report.read 及管理类——经营中心、资金中心隐藏。
  employee: ["order.create", "customer.read", "counterparty.read"],
};

export const DEV_ROLES: { value: string; label: string }[] = [
  { value: "admin", label: "系统管理员" },
  { value: "operator", label: "业务经办人" },
  { value: "finance", label: "财务" },
  { value: "auditor", label: "业务审核人" },
  { value: "viewer", label: "经营查看人" },
  { value: "employee", label: "普通员工" },
];

interface SessionValue {
  /**
   * 系统角色（小写，如 admin / operator / finance），仅用于权限点映射。
   * 与「用户」是两回事：用户是 users 表里的人（id / username / display_name），
   * 角色是 users.role 这一列。需要按人匹配时用 username 或 /auth/me 的 id，勿用本字段。
   */
  role: string;
  /** 当前登录人的用户名（users.username）。与 role 分开保存，避免「拿角色当人比」。 */
  username: string;
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
  // role 与 username 分开存：dev 态直接拿 dev 身份兜底（此时两者同为 dev 用户名，
  // 与 X-Dev-User 直通口径一致）；有 token 时由 /auth/me 分别回填真实角色与用户名。
  const [role, setRole] = useState<string>(currentDevUser());
  const [username, setUsername] = useState<string>(currentDevUser());
  // DEV 态始终视为已登录，使用 X-Dev-User 直通，不受残留生产 token 或首次改密状态影响。
  const [authenticated, setAuthenticated] = useState<boolean>(() => import.meta.env.DEV || Boolean(localStorage.getItem(ACCESS_TOKEN_KEY)));
  const [mustChangePassword, setMustChangePassword] = useState(false);
  useEffect(() => {
    const isDev = import.meta.env.DEV;
    const token = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (isDev) localStorage.removeItem(ACCESS_TOKEN_KEY);
    // 开发态也要从后端同步当前用户：X-Dev-User 是角色别名，不能直接拿来匹配
    // users.username，否则负责人控件无法默认选中真实操作对象。
    if (!token && !isDev) return;
    void currentUserApi().then((current) => {
      if (token && !isDev) setRole(current.role.toLowerCase());
      setUsername(current.username);
      if (!isDev) setMustChangePassword(Boolean(current.must_change_password));
    }).catch(() => {
      if (token && !isDev) {
        localStorage.removeItem(ACCESS_TOKEN_KEY);
        setAuthenticated(false);
      }
    });
  }, []);
  const switchUser = useCallback((next: string) => {
    persistDevUser(next);
    // dev 直通时「当前身份」本身就是这个 dev 用户名，role 与 username 同步。
    setRole(next);
    setUsername(next);
  }, []);
  const login = useCallback(async (account: string, password: string) => {
    if (import.meta.env.DEV && account.trim().toLowerCase() === "admin" && !password) {
      persistDevUser("admin");
      setRole("admin");
      setUsername("admin");
      setMustChangePassword(false);
      setAuthenticated(true);
      return;
    }
    const loggedIn = await loginApi(account, password);
    setRole(loggedIn.role.toLowerCase());
    // 用户名必须单独存：角色来自 users.role，用户名来自 users.username，二者不可互相代替。
    setUsername(loggedIn.username);
    setMustChangePassword(Boolean(loggedIn.must_change_password));
    setAuthenticated(true);
  }, []);
  const changePassword = useCallback(async (oldPassword: string, newPassword: string) => {
    await changePasswordApi(oldPassword, newPassword);
    setMustChangePassword(false);
  }, []);
  const logout = useCallback(async () => {
    if (import.meta.env.DEV) {
      localStorage.removeItem(ACCESS_TOKEN_KEY);
      setAuthenticated(true);
      setMustChangePassword(false);
      return;
    }
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
    const permissions = new Set<string>(ROLE_PERMISSIONS[role] ?? []);
    return { role, username, permissions, can: (code: string) => permissions.has(code), switchUser, authenticated, mustChangePassword, changePassword, login, logout };
  }, [role, username, switchUser, authenticated, mustChangePassword, changePassword, login, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession 必须在 SessionProvider 内使用");
  return ctx;
}
