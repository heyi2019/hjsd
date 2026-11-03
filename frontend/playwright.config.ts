import { defineConfig, devices } from "@playwright/test";

/**
 * 宜游轩 ERP 前端 E2E 配置。
 *
 * 关键约束（来自 src/app/session.tsx / AppShell.tsx / vite.config.ts）：
 *   - DEV 态（`vite` dev server）前端默认已登录（session 内 `import.meta.env.DEV`
 *     为真 → `authenticated` 默认 true），零登录直通；API 在无 token 时自动带
 *     `X-Dev-User`（默认 admin），后端据此开发态旁路鉴权。故 E2E 全部在开发态跑，
 *     无需真实账号。
 *   - 前端 API 基址由 `VITE_API_BASE` 决定（client.ts: API_BASE = VITE_API_BASE ??
 *     http://127.0.0.1:8123/api/v1）。本配置注入 `VITE_API_BASE=/api/v1`（同源相对路径），
 *     由 vite 代理到本套 E2E 后端端口（ERP_E2E_BACKEND_PORT=8124）——后端无 CORS 中间件，
 *     必须用同源代理而非跨域直连，否则请求被浏览器拦截。
 *
 * 数据策略：「人工看保留、自动化清空」。e2e_backend.sh 默认只补表与种子、不删数据
 * （e2e 库同时当第五个可查看环境）；playwright 的 webServer 显式注入 E2E_RESET=1，
 * 才执行 create_all + TRUNCATE 全表 + 重播种子，保证自动化从干净起点跑。
 *
 * 隔离端口：8123/5173 被常驻 dev 后端/前端占用，E2E 独占 8124/5181，彻底绕开业务环境。
 * 可用环境变量覆盖：
 *   ERP_E2E_BACKEND_PORT     后端监听端口（默认 8124）
 *   ERP_E2E_FRONTEND_PORT    前端监听端口（默认 5181）
 */
const E2E_BACKEND_PORT = process.env.ERP_E2E_BACKEND_PORT ?? "8124";
const E2E_FRONTEND_PORT = process.env.ERP_E2E_FRONTEND_PORT ?? "5181";
const E2E_FRONTEND_BASE = `http://127.0.0.1:${E2E_FRONTEND_PORT}`;
// 真实后端联调用例（auth-login / business-write / finance-write-ui 等）的 API 基址：
// 直接打 E2E 独立后端（8124），而非常驻 dev 后端（8123），避免误连业务库。
// 必须为绝对地址——`request` 夹具不绑定 baseURL，相对路径会失败。
process.env.ERP_E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}/api/v1`;
process.env.ERP_E2E_BACKEND_PORT = E2E_BACKEND_PORT;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  expect: { timeout: 10000 },
  // E2E 涉及真实浏览器状态与 antd 下拉，串行最稳，避免并行互相干扰。
  fullyParallel: false,
  workers: 1,
  // 控制台看过程，JSON 供 `backend/scripts/record_e2e_results.py` 翻译进
  // 《测试结果库/results.jsonl》——否则 E2E 跑完只在终端留痕，报告里永远显示 0 条。
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/playwright-report.json" }],
  ],
  use: {
    baseURL: E2E_FRONTEND_BASE,
    headless: true,
    trace: "on-first-retry",
  },
  metadata: {
    backendPort: E2E_BACKEND_PORT,
    apiBase: E2E_FRONTEND_BASE + "/api/v1",
  },
  webServer: [
    {
      // 前端 DEV server：VITE_API_BASE=/api/v1 走同源代理（vite.config.ts 代理到
      // ERP_E2E_BACKEND_PORT=8124），零登录直通。
      command: `ERP_E2E_BACKEND_PORT=${E2E_BACKEND_PORT} VITE_API_BASE=/api/v1 npx vite --port ${E2E_FRONTEND_PORT} --strictPort`,
      url: E2E_FRONTEND_BASE,
      // 端口空闲则起新实例；若已有对应端口的 vite 则复用。
      reuseExistingServer: true,
      timeout: 120000,
    },
    {
      // E2E 后端：e2e_backend.sh 起独立 PG 库（heijin_erp_e2e）+ uvicorn。
      // E2E_RESET=1 只在自动化跑测时清库：人工启动后端默认保留数据（见 e2e_db.py）。
      // reuseExistingServer:false 保证每次强制重建，避免脏数据累积或复用错库。
      command: `E2E_RESET=1 ERP_E2E_BACKEND_PORT=${E2E_BACKEND_PORT} bash ../backend/scripts/e2e_backend.sh`,
      url: `http://127.0.0.1:${E2E_BACKEND_PORT}/api/v1/auth/me`,
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
