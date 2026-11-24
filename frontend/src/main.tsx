import { App, ConfigProvider } from "antd";
import { AppFeedbackBridge } from "./shared/ui/appFeedback";
import zhCN from "antd/locale/zh_CN";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { GlassProvider } from "./shared/state/glass";
import { SessionProvider } from "./shared/state/session";
import { ThemeProvider, useTheme } from "./shared/state/theme";
import { buildTheme } from "./shared/state/antdTheme";
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
import "./shared/styles/responsive.css";
import "./settings/auth/LoginPage.css";

function ThemedApp() {
  const { resolvedMode } = useTheme();
  return (
    <ConfigProvider
      locale={zhCN}
      theme={buildTheme(resolvedMode)}
      // 全局关闭 antd 两字中文按钮自动插空格：「取消/确认/保存」等会被渲染成「取 消/确 认/保 存」。
      // 覆盖所有 Button/Popconfirm/Drawer（含 Portal 到 body 的浮层，React context 沿组件树传递）。
      // 此前靠 BusinessActionModal 等局部 ConfigProvider 各包一层兜底，遗漏了 ConfirmButton；
      // 收口到全局后，局部冗余一并移除，杜绝同类遗漏。
      button={{ autoInsertSpace: false }}
    >
      <App>
        <AppFeedbackBridge />
        <SessionProvider>
          <AppShell />
        </SessionProvider>
      </App>
    </ConfigProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <GlassProvider>
      <HashRouter>
        <ThemedApp />
      </HashRouter>
    </GlassProvider>
  </ThemeProvider>,
);
