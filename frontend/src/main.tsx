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
// 直接操纵反馈层必须排在 ui-components.css / antd-adapter.css 之后：
// 本文件用 :where() 零特异性 + 非 !important，靠层叠顺序取胜，
// 提前导入会被后续规则覆盖（:active 缩量被静默吃掉，零报错）。
import "./shared/styles/interactions.css";
import "./shared/ui/antd-adapter.css";

createRoot(document.getElementById("root")!).render(
  <ConfigProvider locale={zhCN}>
    <SessionProvider>
      <AppShell />
    </SessionProvider>
  </ConfigProvider>,
);
