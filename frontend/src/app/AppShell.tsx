import { Modal, Popconfirm, Space } from "antd";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { navigation } from "./navigation";
import { DEV_ROLES, useSession } from "../shared/state/session";
import { useTheme } from "../shared/state/theme";
import { loadOptionSets } from "../shared/lib/optionSets";
import { DashboardPage } from "./DashboardPage";
import { LoginPage } from "../auth/LoginPage";
import { ChangePasswordPage } from "../auth/ChangePasswordPage";
import type { ComponentType } from "react";
import type { BusinessCenterEntryTab } from "../orders/businessCenter";
import { ErrorBoundary } from "../shared/ui/ErrorBoundary";

/** 业务中心子页记忆：切走再切回时恢复到上次停留的子页，而非强制「库存中心」。 */
const BIZ_TAB_KEY = "erp:businessTab";
type StoredTab = BusinessCenterEntryTab | null;
function getStoredBizTab(): StoredTab {
  try {
    const v = sessionStorage.getItem(BIZ_TAB_KEY);
    return (v as StoredTab) ?? null;
  } catch {
    return null;
  }
}
function setStoredBizTab(tab: BusinessCenterEntryTab): void {
  try {
    sessionStorage.setItem(BIZ_TAB_KEY, tab);
  } catch {
    /* sessionStorage 不可用时静默降级，不影响导航 */
  }
}

const OrdersPage = lazy(() => import("../orders/OrdersPage").then(({ OrdersPage }) => ({ default: OrdersPage })));
const CustomersPage = lazy(() => import("../customers/CustomersPage").then(({ CustomersPage }) => ({ default: CustomersPage })));
const FundsPage = lazy(() => import("../pools/FundsPage").then(({ FundsPage }) => ({ default: FundsPage })));
const ReportsPage = lazy(() => import("../reporting/ReportsPage").then(({ ReportsPage }) => ({ default: ReportsPage })));
const SettingsPage = lazy(() => import("../field-definitions/SettingsPage").then(({ SettingsPage }) => ({ default: SettingsPage })));
const UserCenterPage = lazy(() => import("../auth/UserCenterPage").then(({ UserCenterPage }) => ({ default: UserCenterPage })));

// 注：dashboard 不入此映射——工作台是纯动作入口（无跳转需求），由下方三元单独渲染；
// 其余页面统一收 onNavigate（ReportsPage 的数据中心入口卡跳业务中心用），无跳转需求的页面忽略该 prop。
type PageProps = {
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
  initialTab?: BusinessCenterEntryTab;
  /** keep-alive 下当前页是否处于激活态：非激活仅隐藏不卸载，页面可据此在重新激活时重拉数据。 */
  active?: boolean;
  /** Customer Center deep-link focus, passed from the shell so standalone page tests need no Router context. */
  focusCustomerId?: number;
  focusCounterpartyId?: number;
};
const PAGES: Record<string, ComponentType<PageProps>> = {
  business: OrdersPage,
  customers: CustomersPage,
  funds: FundsPage,
  operations: ReportsPage,
  settings: SettingsPage,
};

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  // 选项词典预加载：让表格展示（StatusTag / labels.ts 映射）在首屏就能读到配置文案，
  // 而不是等某个筛选器组件首次 useOptionSet 时才拉取。
  useEffect(() => {
    void loadOptionSets().catch(() => undefined);
  }, []);
  // 路由化：落点由 URL 唯一决定（深链 / 刷新 / 前进后退可用），不再用 useState 记忆。
  const segments = location.pathname.split("/").filter(Boolean);
  const rawActive = segments[0] ?? "dashboard";
  const active = navigation.some((e) => e.key === rawActive) ? rawActive : "dashboard";
  const customerFocusParams = active === "customers" ? new URLSearchParams(location.search) : null;
  const parsedCustomerFocusId = Number(customerFocusParams?.get("customer_id"));
  const parsedCounterpartyFocusId = Number(customerFocusParams?.get("counterparty_id"));
  const focusCustomerId = Number.isInteger(parsedCustomerFocusId) && parsedCustomerFocusId > 0 ? parsedCustomerFocusId : undefined;
  const focusCounterpartyId = Number.isInteger(parsedCounterpartyFocusId) && parsedCounterpartyFocusId > 0 ? parsedCounterpartyFocusId : undefined;
  const rawBizTab = (segments[1] as BusinessCenterEntryTab | undefined) ?? undefined;
  // 业务中心子页：URL 显式带子页则用它（并记忆）；否则恢复上次记忆，首次默认库存中心。
  const businessTab = active === "business" ? (rawBizTab ?? getStoredBizTab() ?? "inventory") : undefined;
  const [userCenterOpen, setUserCenterOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { user, authenticated, mustChangePassword, logout } = useSession();
  const { mode, setMode } = useTheme();
  const item = navigation.find((entry) => entry.key === active);
  const navigateTo = (key: string, tab?: BusinessCenterEntryTab) => {
    // 回到业务中心但不指定子页时，恢复上次停留的子页（避免被强制回库存中心）。
    if (key === "business" && !tab) {
      navigate(`/business/${getStoredBizTab() ?? "inventory"}`);
      return;
    }
    navigate(`/${key}${tab ? `/${tab}` : ""}`);
  };
  // 空路径 / 或 "" 统一重定向到工作台，保证默认落点稳定。
  useEffect(() => {
    if (location.pathname === "/" || location.pathname === "") {
      navigate("/dashboard", { replace: true });
    }
  }, [location.pathname, navigate]);
  // keep-alive：访问过的页面持续挂载，仅非激活态隐藏（display:none），避免切导航重挂载丢状态。
  const [visited, setVisited] = useState<Set<string>>(() => new Set(["dashboard"]));
  useEffect(() => {
    setVisited((prev) => (prev.has(active) ? prev : new Set(prev).add(active)));
  }, [active]);
  // 业务中心子页落点记忆：URL 显式带子页时持久化，供「切走再切回」恢复。
  useEffect(() => {
    if (active === "business" && rawBizTab) setStoredBizTab(rawBizTab);
  }, [active, rawBizTab]);
  // 转场重放：不再靠 key 重挂载（那会丢状态），改用 reflow 技巧重放 .page-enter 弹簧入场。
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    el.classList.remove("page-enter");
    void el.offsetWidth; // 强制 reflow，使动画重新触发
    el.classList.add("page-enter");
  }, [active]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        navigateTo("business", "inventory");
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateTo]);

  // iOS 26 Scroll Edge Effect：按滚动位置写入上下渐隐距离，内容触边时才渐隐。
  // 未溢出时两值均为 0，mask 退化为全不透明（见 navigation.css 的 .nav-list）。
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    const EDGE = 18;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const max = nav.scrollHeight - nav.clientHeight;
      nav.style.setProperty("--edge-top", `${Math.min(nav.scrollTop, EDGE)}px`);
      nav.style.setProperty("--edge-bottom", `${Math.min(Math.max(max - nav.scrollTop, 0), EDGE)}px`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    nav.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      nav.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
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
        <nav className="nav-list" aria-label="主导航" ref={navRef}>
          {navigation.map((n) => (
            <button
              key={n.key}
              type="button"
              className={`nav-item${n.key === "operations" || n.key === "settings" ? " nav-item--secondary" : ""}${active === n.key ? " nav-item--active" : ""}`}
              onClick={() => navigateTo(n.key)}
              aria-label={n.label}
              title={n.label}
              aria-current={active === n.key ? "page" : undefined}
            >
              <span className="nav-item__icon">{n.icon}</span>
              <span className="nav-item__label">{n.label}</span>
            </button>
          ))}
          <button
            type="button"
            className="mobile-more-button"
            onClick={() => setMoreOpen(true)}
            aria-label="更多导航"
            aria-expanded={moreOpen}
          >
            <span className="nav-item__icon" aria-hidden="true">•••</span>
            <span className="nav-item__label">管理</span>
          </button>
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
                  className={mode === "system" ? "is-active" : ""}
                  aria-pressed={mode === "system"}
                  onClick={() => setMode("system")}
                >
                  系统
                </button>
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
            <Popconfirm
              title="退出登录"
              description="退出后需要重新登录才能继续操作。"
              okText="退出"
              cancelText="取消"
              onConfirm={() => void logout()}
            >
              <button type="button" className="topbar-action topbar-action--logout">退出登录</button>
            </Popconfirm>
          </Space>
        </header>
        <main className="page-content">
          {/* 路由化 + keep-alive：
              1) 落点由 URL 决定（深链/刷新/前进后退可用），见 navigateTo。
              2) 访问过的页面持续挂载，仅非激活态 display:none，避免切导航重挂载丢状态（原 key={active} 的副作用）。
              3) 转场弹簧入场改由 pageRef + reflow 重放（见上方 useEffect），不再靠重挂载。 */}
          <Suspense fallback={<div className="page-loading" role="status">正在打开…</div>}>
            {[...visited, active].filter((k, i, a) => a.indexOf(k) === i).map((key) => {
              const isActive = key === active;
              const PageComponent = key === "dashboard" ? DashboardPage : PAGES[key];
              if (!PageComponent) return null;
              return (
                <ErrorBoundary key={key} name={key}>
                  <div
                    ref={isActive ? pageRef : undefined}
                    className={`page-slot${isActive ? " page-enter" : " page-slot--hidden"}`}
                    aria-hidden={!isActive}
                  >
                    {key === "dashboard" ? (
                      <DashboardPage onNavigate={navigateTo} />
                    ) : (
                      <PageComponent
                        onNavigate={navigateTo}
                        initialTab={key === "business" ? businessTab : undefined}
                        active={isActive}
                        focusCustomerId={key === "customers" ? focusCustomerId : undefined}
                        focusCounterpartyId={key === "customers" ? focusCounterpartyId : undefined}
                      />
                    )}
                  </div>
                </ErrorBoundary>
              );
            })}
          </Suspense>
        </main>
      </div>
      <Modal
        open={userCenterOpen}
        title="用户中心"
        footer={null}
        destroyOnHidden
        onCancel={() => setUserCenterOpen(false)}
        className="user-center-modal"
      >
        <UserCenterPage onClose={() => setUserCenterOpen(false)} />
      </Modal>
      <Modal
        open={moreOpen}
        title="更多"
        footer={null}
        onCancel={() => setMoreOpen(false)}
        className="mobile-more-modal"
      >
        <div className="mobile-more-list" role="menu" aria-label="更多导航">
          {navigation
            .filter((entry) => entry.key === "operations" || entry.key === "settings")
            .map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="menuitem"
                className={active === entry.key ? "is-active" : ""}
                onClick={() => {
                  navigateTo(entry.key);
                  setMoreOpen(false);
                }}
              >
                <span aria-hidden="true">{entry.icon}</span>
                <span>{entry.label}</span>
              </button>
            ))}
          <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); setUserCenterOpen(true); }}>
            <span aria-hidden="true">◉</span>
            <span>用户中心</span>
          </button>
        </div>
      </Modal>
    </div>
  );
}
