import { Modal, Space } from "antd";
import { useState } from "react";
import { navigation } from "./navigation";
import { DEV_ROLES, useSession } from "../shared/state/session";
import { useTheme } from "../shared/state/theme";
import { DashboardPage } from "./DashboardPage";
import { OrdersPage } from "../orders/OrdersPage";
import { CustomersPage } from "../customers/CustomersPage";
import { FundsPage } from "../pools/FundsPage";
import { ReportsPage } from "../reporting/ReportsPage";
import { SettingsPage } from "../field-definitions/SettingsPage";
import { LoginPage } from "../auth/LoginPage";
import { ChangePasswordPage } from "../auth/ChangePasswordPage";
import { UserCenterPage } from "../auth/UserCenterPage";

// 注：dashboard 不入此映射——工作台是纯动作入口（无跳转需求），由下方三元单独渲染；
// 其余页面统一收 onNavigate（ReportsPage 的数据中心入口卡跳业务中心用），无跳转需求的页面忽略该 prop。
type PageProps = { onNavigate?: (key: string) => void };
const PAGES: Record<string, (props: PageProps) => JSX.Element> = {
  business: OrdersPage,
  customers: CustomersPage,
  funds: FundsPage,
  operations: ReportsPage,
  settings: SettingsPage,
};

export function AppShell() {
  const [active, setActive] = useState("dashboard");
  const [userCenterOpen, setUserCenterOpen] = useState(false);
  const { user, authenticated, mustChangePassword, logout } = useSession();
  const { mode, setMode } = useTheme();
  const item = navigation.find((entry) => entry.key === active);
  const Page = PAGES[active] ?? DashboardPage;
  // DEV 与生产同一套退出语义：DEV 初始即已登录（session 内默认 true，X-Dev-User 直通），
  // 点「退出登录」后落登录页，刷新即恢复直通；生产态无 token 同样落登录页。
  if (!authenticated) return <LoginPage />;
  if (mustChangePassword) return <ChangePasswordPage />;
  return (
    <div className="app-shell">
      <aside className="sidebar glass">
        <div className="app-brand">
          <span className="app-brand__mark" aria-hidden="true">宜</span>
          宜游轩 <span>ERP</span>
        </div>
        <nav className="nav-list" aria-label="主导航">
          {navigation.map((n) => (
            <button
              key={n.key}
              type="button"
              className={`nav-item${active === n.key ? " nav-item--active" : ""}`}
              onClick={() => setActive(n.key)}
              aria-current={active === n.key ? "page" : undefined}
            >
              <span className="nav-item__icon">{n.icon}</span>
              <span className="nav-item__label">{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">宜游轩 · 经营工作台</div>
      </aside>
      <div className="main">
        <header className="topbar view-head">
          <div className="topbar__title">
            <h1 className="topbar__page">{item?.label ?? "用户中心"}</h1>
          </div>
          <Space size="small" className="topbar-actions">
            <div className="theme-switch" role="group" aria-label="主题切换">
              <div className="theme-switch-options">
                <button
                  type="button"
                  className={mode === "light" ? "is-active" : ""}
                  aria-pressed={mode === "light"}
                  onClick={() => setMode("light")}
                >
                  浅色
                </button>
                <button
                  type="button"
                  className={mode === "dark" ? "is-active" : ""}
                  aria-pressed={mode === "dark"}
                  onClick={() => setMode("dark")}
                >
                  深色
                </button>
              </div>
            </div>
            {/* 用户中心入口：DEV 与生产态都可从顶栏进入（改密码、看角色权限）。
                以 Modal 弹出挂载 UserCenterPage，不占用侧栏 nav 计数与一级路由。
                用 .topbar-action 紧凑幽灵按钮（36px，与分段控件/选择器同高），
                不再复用 .nav-item（44px 会把顶栏整行撑高）。 */}
            <button type="button" className="topbar-action" onClick={() => setUserCenterOpen(true)}>
              用户中心
            </button>
            {/* 当前角色只读展示：角色由管理员配置（生产态=登录账号角色，DEV 态=X-Dev-User 头），
                不是运行时可选参数——故不放下拉选择器，避免误以为可自行切换权限。 */}
            <span className="topbar-role">
              <span className="muted">当前角色{import.meta.env.DEV ? "（开发态）" : ""}</span>
              <span className="topbar-role-name">{DEV_ROLES.find((r) => r.value === user)?.label ?? user}</span>
            </span>
            <button type="button" className="topbar-action" onClick={() => void logout()}>退出登录</button>
          </Space>
        </header>
        <main className="page-content">
          {/* 工作台单独渲染（纯动作入口）；其余页面走 PAGES 映射并收 onNavigate，
              供数据中心入口卡跳转业务中心；无跳转需求的页面忽略该 prop。
              key={active} 让每次导航切换重挂载 .page-enter，重放 Apple 弹簧入场转场。 */}
          <div className="page-enter" key={active}>
            {active === "dashboard" ? <DashboardPage /> : <Page onNavigate={setActive} />}
          </div>
        </main>
      </div>
      <Modal
        open={userCenterOpen}
        title="用户中心"
        footer={null}
        destroyOnHidden
        onCancel={() => setUserCenterOpen(false)}
      >
        <UserCenterPage onClose={() => setUserCenterOpen(false)} />
      </Modal>
    </div>
  );
}
