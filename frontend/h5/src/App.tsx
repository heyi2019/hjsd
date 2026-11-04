import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { TOKEN_KEY, fetchMe, type SessionUser } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { ChangePasswordPage } from "./pages/ChangePasswordPage";
import { DashboardPage } from "./pages/DashboardPage";
import { BusinessPage, type BusinessTab } from "./pages/business/BusinessPage";
import { OrderDetailPage } from "./pages/business/OrderDetailPage";
import { OrderCreatePage } from "./pages/business/OrderCreatePage";
import { OrderEditPage } from "./pages/business/OrderEditPage";
import { OrderRefundPage } from "./pages/business/OrderRefundPage";
import { StockDetailPage } from "./pages/business/StockDetailPage";
import { StockSalePage } from "./pages/business/StockSalePage";
import { CustomersPage } from "./pages/customers/CustomersPage";
import { CustomerDetailPage } from "./pages/customers/CustomerDetailPage";
import { CustomerFormPage } from "./pages/customers/CustomerFormPage";
import { FundsPage } from "./pages/funds/FundsPage";
import { MinePage } from "./pages/MinePage";
import { isUnder, matchPath, navigate, useRoute } from "./router";
import { CustomersIcon, HomeIcon, ListIcon, PersonIcon, WalletIcon } from "./icons";

type TabKey = "dashboard" | "business" | "customers" | "funds" | "mine";

/** 底栏五项：与桌面一级导航一一对应（经营中心与设置收在「我的」里，见 MinePage）。 */
const TABS: { key: TabKey; label: string; to: string; Icon: typeof HomeIcon }[] = [
  { key: "dashboard", label: "工作台", to: "/dashboard", Icon: HomeIcon },
  { key: "business", label: "业务", to: "/business/inventory", Icon: ListIcon },
  { key: "customers", label: "客户", to: "/customers", Icon: CustomersIcon },
  { key: "funds", label: "资金", to: "/funds", Icon: WalletIcon },
  { key: "mine", label: "我的", to: "/mine", Icon: PersonIcon },
];

const BUSINESS_TABS: BusinessTab[] = ["inventory", "ledger", "collections"];

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [booting, setBooting] = useState(true);
  const { path } = useRoute();

  // 启动即校验令牌：过期的令牌必须在这里清掉，否则后续每个请求都会 401，
  // 用户看到的是「页面一堆红色提示」而不是「回到登录页」。
  useEffect(() => {
    if (!localStorage.getItem(TOKEN_KEY)) {
      setBooting(false);
      return;
    }
    let alive = true;
    void fetchMe()
      .then((me) => {
        if (alive) setUser(me);
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
      })
      .finally(() => {
        if (alive) setBooting(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 换页回到顶部：移动端从长列表点进详情后，滚动位置若保留会直接落在详情页中段。
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);

  const handleSignedIn = useCallback(async () => {
    setUser(await fetchMe());
    navigate("/dashboard", true);
  }, []);

  const handleSignOut = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    navigate("/dashboard", true);
  }, []);

  const handlePasswordChanged = useCallback(async () => {
    setUser(await fetchMe());
  }, []);

  if (booting) {
    return (
      <div className="h5-boot">
        <div className="h5-boot__spinner" />
        <p>正在校验登录状态…</p>
      </div>
    );
  }

  if (!user) {
    return <LoginPage onSignedIn={handleSignedIn} />;
  }

  // 强制改密是登录后的硬闸门：桌面端同样如此，两端口径必须一致。
  if (user.must_change_password) {
    return <ChangePasswordPage user={user} onDone={handlePasswordChanged} onSignOut={handleSignOut} />;
  }

  const { screen, tab } = resolveScreen(path, user, handleSignOut, setUser);

  return (
    <div className="h5-app">
      <main className={tab ? "h5-main" : "h5-main h5-main--plain"}>{screen}</main>
      {tab ? <TabBar active={tab} /> : null}
    </div>
  );
}

function TabBar({ active }: { active: TabKey }) {
  return (
    <nav className="h5-tabbar" aria-label="主导航">
      {TABS.map(({ key, label, to, Icon }) => {
        const isActive = key === active;
        return (
          <button
            key={key}
            type="button"
            className={`h5-tabbar__item${isActive ? " is-active" : ""}`}
            aria-current={isActive ? "page" : undefined}
            onClick={() => navigate(to)}
          >
            <span className="h5-tabbar__icon">
              <Icon filled={isActive} />
            </span>
            <span className="h5-tabbar__label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * 路径 → 页面。返回 tab 表示该路径属于一级导航（渲染底栏），
 * 返回 null 表示详情/表单页（顶栏返回，不显示底栏）。
 */
function resolveScreen(
  path: string,
  user: SessionUser,
  onSignOut: () => void,
  onUserChange: (next: SessionUser) => void,
): { screen: ReactNode; tab: TabKey | null } {
  if (path === "/" || path === "/dashboard") {
    return {
      screen: <DashboardPage user={user} onOpenOrders={() => navigate("/business/ledger")} />,
      tab: "dashboard",
    };
  }

  if (isUnder(path, "/business")) {
    const raw = path.split("/")[2];
    const tab: BusinessTab = BUSINESS_TABS.includes(raw as BusinessTab) ? (raw as BusinessTab) : "inventory";
    return { screen: <BusinessPage tab={tab} user={user} />, tab: "business" };
  }

  // 三段路径必须排在两段的 /orders/:id 之前，否则 "new"/"edit" 会被当成 id。
  const createMatch = matchPath("/orders/new/:kind", path);
  if (createMatch) {
    const kind = createMatch.kind.toUpperCase();
    if (kind === "HS" || kind === "TH" || kind === "DG") {
      return { screen: <OrderCreatePage kind={kind} />, tab: null };
    }
  }

  const editMatch = matchPath("/orders/:id/edit", path);
  if (editMatch) {
    return { screen: <OrderEditPage orderId={Number(editMatch.id)} />, tab: null };
  }

  const refundMatch = matchPath("/orders/:id/refund", path);
  if (refundMatch) {
    return { screen: <OrderRefundPage orderId={Number(refundMatch.id)} />, tab: null };
  }

  const orderMatch = matchPath("/orders/:id", path);
  if (orderMatch) {
    return { screen: <OrderDetailPage orderId={Number(orderMatch.id)} />, tab: null };
  }

  const saleMatch = matchPath("/stocks/:id/sale", path);
  if (saleMatch) {
    return { screen: <StockSalePage stockId={Number(saleMatch.id)} />, tab: null };
  }

  const stockMatch = matchPath("/stocks/:id", path);
  if (stockMatch) {
    return { screen: <StockDetailPage stockId={Number(stockMatch.id)} />, tab: null };
  }

  if (path === "/customers") {
    return { screen: <CustomersPage />, tab: "customers" };
  }

  // 必须排在下方的 :id 之前：否则 "new" 会被当成客户 id 解析成 NaN。
  if (path === "/customers/new") {
    return { screen: <CustomerFormPage />, tab: null };
  }

  const customerMatch = matchPath("/customers/:id", path);
  if (customerMatch) {
    return { screen: <CustomerDetailPage customerId={Number(customerMatch.id)} />, tab: null };
  }

  if (path === "/funds") {
    return { screen: <FundsPage />, tab: "funds" };
  }

  if (path === "/mine") {
    return { screen: <MinePage user={user} onSignOut={onSignOut} onUserChange={onUserChange} />, tab: "mine" };
  }

  return { screen: <NotFound path={path} />, tab: null };
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="h5-page">
      <header className="h5-navbar">
        <button type="button" className="h5-navbar__back" onClick={() => navigate("/dashboard", true)}>
          返回工作台
        </button>
      </header>
      <div className="h5-section">
        <p className="h5-empty">没有这个页面：{path}</p>
      </div>
    </div>
  );
}
