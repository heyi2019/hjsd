import { Select, Space } from "antd";
import { useState } from "react";
import { navigation } from "./navigation";
import { DEV_ROLES, useSession } from "../shared/state/session";
import { useTheme } from "../shared/state/theme";
import { DashboardPage } from "./DashboardPage";
import { OrdersPage } from "../orders/OrdersPage";
import { CustomersPage } from "../customers/CustomersPage";
import { FundsPage } from "../pools/FundsPage";
import { ReportsPage } from "../reporting/ReportsPage";
import { QualityWorkbench } from "../quality/QualityWorkbench";
import { HistoryWorkbench } from "../history/HistoryWorkbench";
import { SettingsPage } from "../field-definitions/SettingsPage";
import { LoginPage } from "../auth/LoginPage";
import { ChangePasswordPage } from "../auth/ChangePasswordPage";

const PAGES: Record<string, () => JSX.Element> = {
  dashboard: DashboardPage,
  business: OrdersPage,
  customers: CustomersPage,
  funds: FundsPage,
  operations: ReportsPage,
  quality: QualityWorkbench,
  history: HistoryWorkbench,
  settings: SettingsPage,
};

export function AppShell() {
  const [active, setActive] = useState("dashboard");
  const { user, switchUser, authenticated, mustChangePassword, logout } = useSession();
  const { mode, setMode } = useTheme();
  const item = navigation.find((entry) => entry.key === active)!;
  const Page = PAGES[active] ?? DashboardPage;
  if (!import.meta.env.DEV && !authenticated) return <LoginPage />;
  if (!import.meta.env.DEV && mustChangePassword) return <ChangePasswordPage />;
  return (
    <div className="app-shell">
      <aside className="sidebar glass">
        <div className="app-brand">
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
            <span className="topbar__eyebrow">宜游轩 ERP</span>
            <h1 className="topbar__page">{item.label}</h1>
          </div>
          <Space size="small">
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
            {import.meta.env.DEV ? <><span className="muted">当前角色（开发态）</span><Select size="small" value={user} style={{ width: 140 }} options={DEV_ROLES} onChange={switchUser} /></> : <button type="button" className="nav-item" onClick={() => void logout()}>退出登录</button>}
          </Space>
        </header>
        <main className="page-content">
          <Page />
        </main>
      </div>
    </div>
  );
}
