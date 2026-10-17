import { defineConfig, devices } from "@playwright/test";

/**
 * 宜游轩 ERP 前端 E2E 配置。
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
  // 可用 ERP_E2E_BACKEND_PORT / ERP_E2E_API_BASE 指向隔离联调服务；默认保持本地 8123。
  metadata: {
    backendPort: process.env.ERP_E2E_BACKEND_PORT ?? "8123",
  },
  webServer: [
    {
      command: `VITE_API_BASE=${process.env.ERP_E2E_API_BASE ?? "/api/v1"} npx vite --port 5180 --strictPort`,
      url: "http://localhost:5180",
      // 端口空闲则起新实例；若已有 vite 在 5180 则复用。
      reuseExistingServer: true,
      timeout: 120000,
    },
    {
      // 联调 e2e（auth-login / integration）需要真实后端。自动拉起 uvicorn，
      // 绑 0.0.0.0 以便前端 .env.local 的 LAN IP（192.168.124.12:8123）也能到达；
      // 若 8123 已有实例则复用（reuseExistingServer）。本机 8000 被 Docker 占用，用 8123。
      command:
        `cd /Users/aries/黑金时代/backend && /Users/aries/Applications/Python_3.13/bin/python3 -m uvicorn app.main:app --host 0.0.0.0 --port ${process.env.ERP_E2E_BACKEND_PORT ?? "8123"}`,
      url: `http://127.0.0.1:${process.env.ERP_E2E_BACKEND_PORT ?? "8123"}/api/v1/auth/me`,
      reuseExistingServer: true,
      timeout: 120000,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
