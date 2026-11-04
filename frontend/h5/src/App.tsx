import { useCallback, useEffect, useState } from "react";
import { TOKEN_KEY, fetchMe, type SessionUser } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { HomePage } from "./pages/HomePage";
import { OrdersPage } from "./pages/OrdersPage";
import { MinePage } from "./pages/MinePage";
import { ChangePasswordPage } from "./pages/ChangePasswordPage";
import { HomeIcon, ListIcon, PersonIcon } from "./icons";

export type TabKey = "home" | "orders" | "mine";

const TABS: { key: TabKey; label: string; Icon: typeof HomeIcon }[] = [
  { key: "home", label: "工作台", Icon: HomeIcon },
  { key: "orders", label: "业务", Icon: ListIcon },
  { key: "mine", label: "我的", Icon: PersonIcon },
];

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<TabKey>("home");

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

  const handleSignedIn = useCallback(async () => {
    const me = await fetchMe();
    setUser(me);
    setTab("home");
  }, []);

  const handleSignOut = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    setTab("home");
  }, []);

  const handlePasswordChanged = useCallback(async () => {
    const me = await fetchMe();
    setUser(me);
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

  return (
    <div className="h5-app">
      <main className="h5-main">
        {tab === "home" ? <HomePage user={user} onOpenOrders={() => setTab("orders")} /> : null}
        {tab === "orders" ? <OrdersPage /> : null}
        {tab === "mine" ? <MinePage user={user} onSignOut={handleSignOut} onUserChange={setUser} /> : null}
      </main>
      <nav className="h5-tabbar" aria-label="主导航">
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            className={`h5-tabbar__item${tab === key ? " is-active" : ""}`}
            aria-current={tab === key ? "page" : undefined}
            onClick={() => setTab(key)}
          >
            <span className="h5-tabbar__icon">
              <Icon filled={tab === key} />
            </span>
            <span className="h5-tabbar__label">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
