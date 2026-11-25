/** 权限点：以后端 `core/security.py` 的 `PERM_*` 为唯一来源。
 * 前端只用它控制按钮显隐；后端仍会二次鉴权，隐藏菜单不构成权限控制。 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ACCESS_TOKEN_KEY, changePassword as changePasswordApi, changeUsername as changeUsernameApi, currentDevUser, currentUser as currentUserApi, login as loginApi, logout as logoutApi, setDevUser as persistDevUser } from "../api/client";

export const ALL_PERMISSIONS = [
  "customer.read",
  "customer.export",
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
  "user.manage",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

/** 角色 → 权限点。导出仅供测试与权限矩阵校验使用；运行时请走 useSession().can。 */
export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  operator: [
    "customer.read",
    "customer.export",
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
    "customer.export",
    "counterparty.read",
    "audit.read",
    "report.read",
    "report.export",
  ],
  auditor: [
    "finance.read",
    "customer.read",
    "customer.export",
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
  displayName: string | null;
  /** 开发态请求以 X-Dev-User 识别，资料同步返回的用户名可能不同。 */
  dataOwnerKey: string;
  permissions: Set<string>;
  can: (code: string) => boolean;
  switchUser: (user: string) => void;
  authenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  mustChangePassword: boolean;
  sessionError: string | null;
  changeUsername: (username: string, currentPassword: string) => Promise<void>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({
  children,
  syncDevUser = true,
}: {
  children: ReactNode;
  /** 组件测试默认关闭后端同步；生产开发页保持真实用户同步。 */
  syncDevUser?: boolean;
}) {
  // role 与 username 分开存：dev 态直接拿 dev 身份兜底（此时两者同为 dev 用户名，
  // 与 X-Dev-User 直通口径一致）；有 token 时由 /auth/me 分别回填真实角色与用户名。
  const [role, setRole] = useState<string>(currentDevUser());
  const [username, setUsername] = useState<string>(currentDevUser());
  const [displayName, setDisplayName] = useState<string | null>(null);
  // DEV 态始终视为已登录，使用 X-Dev-User 直通，不受残留生产 token 或首次改密状态影响。
  const [authenticated, setAuthenticated] = useState<boolean>(() => import.meta.env.DEV || Boolean(localStorage.getItem(ACCESS_TOKEN_KEY)));
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const sessionGeneration = useRef(0);
  const userRefreshVersion = useRef(0);
  const syncDevProfile = import.meta.env.DEV && syncDevUser && authenticated;
  useEffect(() => {
    let active = true;
    const generation = sessionGeneration.current;
    const isDev = import.meta.env.DEV;
    const token = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (isDev) localStorage.removeItem(ACCESS_TOKEN_KEY);
    // 开发态也要从后端同步当前用户：X-Dev-User 是角色别名，不能直接拿来匹配
    // users.username，否则负责人控件无法默认选中真实操作对象。组件测试可显式关闭，
    // 避免纯组件用例依赖本地后端。
    if (isDev && !syncDevProfile) return;
    if (!token && !isDev) return;
    const refreshVersion = ++userRefreshVersion.current;
    void currentUserApi().then((current) => {
      if (!active || generation !== sessionGeneration.current || refreshVersion !== userRefreshVersion.current) return;
      if (token && !isDev) setRole(current.role.toLowerCase());
      setUsername(current.username);
      setDisplayName(current.display_name ?? null);
      if (!isDev) setMustChangePassword(Boolean(current.must_change_password));
    }).catch(() => {
      // 网络故障保留会话；实际 401 由客户端统一失效通知处理。
    });
    return () => { active = false; };
  }, [syncDevProfile]);
  useEffect(() => {
    const onExpired = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      sessionGeneration.current += 1;
      setAuthenticated(false);
      setMustChangePassword(false);
      setSessionError(message || "登录已失效，请重新登录");
    };
    window.addEventListener("erp:session-expired", onExpired);
    return () => window.removeEventListener("erp:session-expired", onExpired);
  }, []);
  useEffect(() => {
    if (!authenticated || import.meta.env.DEV || !syncDevUser) return;
    let active = true;
    const refresh = async () => {
      const generation = sessionGeneration.current;
      const version = ++userRefreshVersion.current;
      const token = localStorage.getItem(ACCESS_TOKEN_KEY);
      if (!token) return;
      try {
        const current = await currentUserApi();
        if (!active || generation !== sessionGeneration.current || version !== userRefreshVersion.current || localStorage.getItem(ACCESS_TOKEN_KEY) !== token) return;
        setRole(current.role.toLowerCase());
        setUsername(current.username);
        setDisplayName(current.display_name ?? null);
        setMustChangePassword(Boolean(current.must_change_password));
      } catch { /* 客户端负责会话失效，网络错误不改变现有状态。 */ }
    };
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 60_000);
    return () => { active = false; window.removeEventListener("focus", onFocus); window.clearInterval(timer); };
  }, [authenticated, syncDevUser]);
  const switchUser = useCallback((next: string) => {
    sessionGeneration.current += 1;
    persistDevUser(next);
    // dev 直通时「当前身份」本身就是这个 dev 用户名，role 与 username 同步。
    setRole(next);
    setUsername(next);
    setDisplayName(null);
  }, []);
  const login = useCallback(async (account: string, password: string) => {
    const generation = ++sessionGeneration.current;
    setSessionError(null);
    if (import.meta.env.DEV && account.trim().toLowerCase() === "admin" && !password) {
      persistDevUser("admin");
      setRole("admin");
      setUsername("admin");
      setDisplayName(null);
      setMustChangePassword(false);
      setAuthenticated(true);
      return;
    }
    const loggedIn = await loginApi(account, password);
    if (generation !== sessionGeneration.current) return;
    setRole(loggedIn.role.toLowerCase());
    // 用户名必须单独存：角色来自 users.role，用户名来自 users.username，二者不可互相代替。
    setUsername(loggedIn.username);
    setDisplayName(loggedIn.display_name ?? null);
    setMustChangePassword(Boolean(loggedIn.must_change_password));
    setAuthenticated(true);
  }, []);
  const changeUsername = useCallback(async (nextUsername: string, currentPassword: string) => {
    const generation = sessionGeneration.current;
    const updated = await changeUsernameApi(nextUsername, currentPassword);
    if (generation !== sessionGeneration.current) return;
    userRefreshVersion.current += 1;
    setUsername(updated.username);
    setDisplayName(updated.display_name ?? null);
  }, []);
  const changePassword = useCallback(async (oldPassword: string, newPassword: string) => {
    await changePasswordApi(oldPassword, newPassword);
    setMustChangePassword(false);
  }, []);
  const logout = useCallback(async () => {
    sessionGeneration.current += 1;
    // 先结束本地会话，再尝试通知服务端；网络慢或后端不可达时也必须立即落登录页。
    setAuthenticated(false);
    setMustChangePassword(false);
    setSessionError(null);
    // 后端 /auth/logout 失败也必须退出本地会话：否则「退出登录」点了没反应，
    // 用户以为已退出却仍停留在已登录界面。
    try {
      await logoutApi();
    } catch {
      // 退出是本地会话的终止动作，不应被后端不可达阻断或产生未处理拒绝。
      // 服务端若可达会撤销旧 token；本地已立即结束该会话。
    }
  }, []);
  const value = useMemo<SessionValue>(() => {
    const permissions = new Set<string>(ROLE_PERMISSIONS[role] ?? []);
    const dataOwnerKey = import.meta.env.DEV ? currentDevUser() : username;
    return { role, username, displayName, dataOwnerKey, permissions, can: (code: string) => permissions.has(code), switchUser, authenticated, mustChangePassword, sessionError, changeUsername, changePassword, login, logout };
  }, [role, username, displayName, switchUser, authenticated, mustChangePassword, sessionError, changeUsername, changePassword, login, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession 必须在 SessionProvider 内使用");
  return ctx;
}
