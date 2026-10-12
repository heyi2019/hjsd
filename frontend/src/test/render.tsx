/** 组件测试渲染助手：与 main.tsx 的 Provider 组合保持一致（ConfigProvider → Theme → Session）。
 *  测试里不需要加载 CSS：jsdom 只验证 DOM 结构与交互，样式由 ui_guards + 浏览器实测把关。 */
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { render } from "@testing-library/react";
import type { RenderOptions, RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { SessionProvider } from "../shared/state/session";
import { ThemeProvider } from "../shared/state/theme";
import { DEV_USER_KEY } from "../shared/api/client";

export function AllProviders({ children }: { children: ReactNode }) {
  return (
    // 关闭 antd 中文按钮自动插空格（"建 单"），否则所有按按钮文案定位的断言都要写正则。
    // 注：antd 5.29 起 autoInsertSpaceInButton 已废弃，改走 button.autoInsertSpace。
    <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }}>
      <ThemeProvider>
        <SessionProvider>{children}</SessionProvider>
      </ThemeProvider>
    </ConfigProvider>
  );
}

/** 以指定 dev 角色渲染组件；user 会先写入 localStorage，SessionProvider 据此解析权限。 */
export function renderApp(
  ui: ReactElement,
  options: { user?: string } & Omit<RenderOptions, "wrapper"> = {},
): RenderResult {
  const { user, ...rest } = options;
  if (user !== undefined) localStorage.setItem(DEV_USER_KEY, user);
  return render(ui, { wrapper: AllProviders, ...rest });
}
