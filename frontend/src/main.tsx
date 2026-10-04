import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app/AppShell";
import { SessionProvider } from "./shared/state/session";
import "./styles.css";
import "./system-shell.css";
import "./shared/styles/tokens.css";
import "./shared/styles/typography.css";
import "./shared/styles/a11y.css";
import "./shared/styles/hierarchy.css";
import "./shared/styles/page-layouts.css";
import "./shared/styles/navigation.css";
import "./shared/styles/ui-components.css";
import "./shared/ui/antd-adapter.css";

createRoot(document.getElementById("root")!).render(
  <ConfigProvider locale={zhCN}>
    <SessionProvider>
      <AppShell />
    </SessionProvider>
  </ConfigProvider>,
);
