import { defineConfig, devices } from "@playwright/test";

/**
 * 黑金时代 ERP 前端 E2E 配置。
 *
 * 关键约束（来自 src/app/AppShell.tsx）：
 *   - `import.meta.env.DEV` 为真时直接进 AppShell，跳过登录（DEV 态）。
 *   - 开发态提供「角色切换」Select（X-Dev-User），无需真后端认证。
 * 因此 webServer 用 `vite` dev server（DEV 态零登录），E2E 全部在开发态跑。
 *
 * 为避免 E2E 依赖后端存活，smoke / role-switch 用例通过 page.route 拦截
 * `/api/v1/**` 返回安全 stub（空列表/空对象），验证「真渲染路径」而非降级。
 * fallback 用例刻意不拦截，验证后端不可达时页面仍渲染外壳（不白屏）。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  expect: { timeout: 10000 },
  // E2E 涉及真实浏览器状态与 antd 下拉，串行最稳，避免并行互相干扰。
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5180",
    headless: true,
    trace: "on-first-retry",
  },
  webServer: {
    command: "npx vite --port 5180 --strictPort",
    url: "http://localhost:5180",
    // 端口空闲则起新实例；若已有 vite 在 5180 则复用。
    reuseExistingServer: true,
    timeout: 120000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
