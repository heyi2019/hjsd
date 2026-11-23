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
 *     http://127.0.0.1:8123/api）。本配置注入 `VITE_API_BASE=/api`（同源相对路径），
 *     由 vite 代理到本套 E2E 后端端口（ERP_E2E_BACKEND_PORT=8124）——后端无 CORS 中间件，
 *     必须用同源代理而非跨域直连，否则请求被浏览器拦截。
 *
 * 数据策略：通过 npm run test:e2e 创建本次独有的临时库，成功后清理；失败时保留供排查。
 *
 * 隔离端口：8123/5173 被常驻 dev 后端/前端占用，E2E 独占 8124/5181，彻底绕开业务环境。
 * 可用环境变量覆盖：
 *   ERP_E2E_BACKEND_PORT     后端监听端口（默认 8124）
 *   ERP_E2E_FRONTEND_PORT    前端监听端口（默认 5181）
 */
const E2E_BACKEND_PORT = process.env.ERP_E2E_BACKEND_PORT ?? "8124";
if (process.env.HEIJIN_EPHEMERAL_E2E !== "1") {
  throw new Error("请使用 npm run test:e2e 启动，确保 E2E 使用隔离临时库。");
}
const E2E_FRONTEND_PORT = process.env.ERP_E2E_FRONTEND_PORT ?? "5181";
const E2E_FRONTEND_BASE = `http://127.0.0.1:${E2E_FRONTEND_PORT}`;
// 真实后端联调用例（auth-login / business-write / finance-write-ui 等）的 API 基址：
// 直接打 E2E 独立后端（8124），而非常驻 dev 后端（8123），避免误连业务库。
// 必须为绝对地址——`request` 夹具不绑定 baseURL，相对路径会失败。
process.env.ERP_E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}/api`;
process.env.ERP_E2E_BACKEND_PORT = E2E_BACKEND_PORT;

export default defineConfig({
  // 规格家在仓库根 tests/e2e/<区域>/（2026-11-04 从包内 e2e/ 迁出，与 vitest 的
  // tests/frontend/ 同构：区域目录 + 支撑文件）。快照目录跟着 spec 走，
  // `visual.spec.ts-snapshots/` 已随 visual.spec.ts 一起迁到 tests/e2e/system/。
  testDir: "../tests/e2e",
  // 一致性修复 E2E 系统性 flake（2026-11-06）：CI 负载下后端/浏览器响应变慢、
  // click 动作可达性竞态，失败用例每轮都在变（视觉基线→弹窗缩放→走查超时），
  // 属负载型而非逻辑型。根因修复＝统一重试 + 给足超时余量：真 bug 重试后仍失败
  // （被 loud 暴露），负载型 flake 重试即过。本地（无 CI env）retries=0 不掩盖问题。
  timeout: 60000,
  expect: { timeout: 15000 },
  // CI 环境自动重试 2 次（Playwright 官方 CI 推荐值）；本地跑不重试。
  retries: process.env.CI ? 2 : 0,
  // E2E 整轮串行（workers:1）的原因（2026-11-04 实测验证，勿擅自改并行）：
  //   ① 写库用例共享 heijin_erp_e2e 的 document_sequences 计数器，并发会撞唯一约束 → flaky。
  //   ② 纯 UI / 只读用例虽不写库，但有两个结构性脆弱点：
  //      - visual 基线拍的是「写后数据态」，拆分执行顺序后仪表盘实时数字变了 → 截图 1% 差异失败；
  //      - 共享 vite dev server 在多浏览器上下文并发下加载竞争，form hydration 超时类 flaky
  //        （order-abandon-confirm 点关闭后确认框未弹出即一例）。
  //   ③ 试过「write 串行 + readonly 并行 + dependencies 串行两段」：仍触发 ② 的两类失败。
  // 结论：E2E 有状态 + 时序敏感，硬并行引入 flaky；维持串行。前述「提速杠杆」已落地：
  // 前端 webServer 改用 `vite build --mode e2e` + `vite preview`（静态产物，无 dev server
  // 的 per-request transform 竞争，多上下文加载更稳）；`--mode e2e` 由 vite.config.ts
  // define import.meta.env.DEV=true，保留零登录直通。详见 webServer[0]。
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
    apiBase: E2E_FRONTEND_BASE + "/api",
  },
  webServer: [
    {
      // 前端：vite build --mode e2e（vite.config.ts 在该模式 define import.meta.env.DEV=true，
      // 保留零登录直通——session.tsx 依赖 DEV 为真 → 后端开发态旁路鉴权）→ vite preview
      // 静态产物服务。相较 dev server，preview 无 per-request transform，多浏览器上下文加载
      // 无竞争，E2E 更稳。VITE_API_BASE=/api 由 preview 代理（preview.proxy）转到本套
      // E2E 后端（8124）。reuseExistingServer:false 确保每次新构建的 preview，不误复用
      // 常驻 dev server（5173）或残留实例。
      command: `ERP_E2E_BACKEND_PORT=${E2E_BACKEND_PORT} VITE_API_BASE=/api npx vite build --mode e2e && npx vite preview --port ${E2E_FRONTEND_PORT} --strictPort`,
      url: E2E_FRONTEND_BASE,
      reuseExistingServer: false,
      timeout: 180000,
    },
    {
      // E2E 后端使用运行入口创建的独立临时库与 uvicorn。
      // reuseExistingServer:false 保证每次强制重启 uvicorn，避免复用错的后端实例。
      command: `ERP_E2E_BACKEND_PORT=${E2E_BACKEND_PORT} bash ../backend/scripts/e2e_backend.sh`,
      url: `http://127.0.0.1:${E2E_BACKEND_PORT}/api/auth/me`,
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
