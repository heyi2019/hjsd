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

// E2E 隔离联调端口：8123 被用户常驻的「黑金时代生产 dev 后端」占用（连生产库
// heijin_erp_v1.db），E2E 必须独占 8124，彻底绕开生产库。可用环境变量覆盖：
//   ERP_E2E_BACKEND_PORT  后端监听端口（默认 8124）
//   ERP_E2E_API_BASE      测试进程内后端基址（默认 http://127.0.0.1:8124/api/v1）
// 所有 e2e spec 通过 process.env.ERP_E2E_API_BASE 读取后端基址，故在此显式注入，
// 保证与 backend webServer 端口严格一致。
const E2E_BACKEND_PORT = process.env.ERP_E2E_BACKEND_PORT ?? "8124";
const E2E_API_BASE =
  process.env.ERP_E2E_API_BASE ?? `http://127.0.0.1:${E2E_BACKEND_PORT}/api/v1`;
const E2E_FRONTEND_PORT = process.env.ERP_E2E_FRONTEND_PORT ?? "5180";
const E2E_FRONTEND_BASE = `http://127.0.0.1:${E2E_FRONTEND_PORT}`;
process.env.ERP_E2E_API_BASE = E2E_API_BASE;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  expect: { timeout: 10000 },
  // E2E 涉及真实浏览器状态与 antd 下拉，串行最稳，避免并行互相干扰。
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: E2E_FRONTEND_BASE,
    headless: true,
    trace: "on-first-retry",
  },
  metadata: {
    backendPort: E2E_BACKEND_PORT,
    apiBase: E2E_API_BASE,
  },
  webServer: [
    {
      command: `VITE_API_BASE=${E2E_API_BASE} npx vite --port ${E2E_FRONTEND_PORT} --strictPort`,
      url: E2E_FRONTEND_BASE,
      // 端口空闲则起新实例；若已有对应端口的 vite 则复用。
      reuseExistingServer: true,
      timeout: 120000,
    },
    {
      // 联调 e2e（auth-login / integration / business-write / crud）需要真实后端。
      // 通过 e2e_backend.sh 重建**独立 E2E 库**（heijin_erp_e2e.db），绝不写入
      // 生产库 heijin_erp_v1.db；每次运行都迁移 + 种子 + 起 uvicorn。
      // reuseExistingServer:false 保证每次强制重建，避免脏数据累积或复用错库。
      // 独占 8124，绕开 8123 的生产 dev 后端。
      command: "bash ../backend/scripts/e2e_backend.sh",
      url: `http://127.0.0.1:${E2E_BACKEND_PORT}/api/v1/auth/me`,
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
