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
 * 数据策略：复用常驻 e2e 库，不再每次重建。e2e_backend.sh 默认（不清数据）只补缺失表
 * + 幂等播种；e2e_db.py 的夹具按 (business_mode, inventory_type) 补足 IN_STOCK 账号，
 * 故用例消耗在库账号后下一轮仍能补齐，自动化直接复用既有库（省 5–15s 启动 + 重播种子）。
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
  // 规格家在仓库根 tests/e2e/<区域>/（2026-11-04 从包内 e2e/ 迁出，与 vitest 的
  // tests/frontend/ 同构：区域目录 + 支撑文件）。快照目录跟着 spec 走，
  // `visual.spec.ts-snapshots/` 已随 visual.spec.ts 一起迁到 tests/e2e/system/。
  testDir: "../tests/e2e",
  timeout: 30000,
  expect: { timeout: 10000 },
  // E2E 整轮串行（workers:1）的原因（2026-11-04 实测验证，勿擅自改并行）：
  //   ① 写库用例共享 heijin_erp_e2e 的 document_sequences 计数器，并发会撞唯一约束 → flaky。
  //   ② 纯 UI / 只读用例虽不写库，但有两个结构性脆弱点：
  //      - visual 基线拍的是「写后数据态」，拆分执行顺序后仪表盘实时数字变了 → 截图 1% 差异失败；
  //      - 共享 vite dev server 在多浏览器上下文并发下加载竞争，form hydration 超时类 flaky
  //        （order-abandon-confirm 点关闭后确认框未弹出即一例）。
  //   ③ 试过「write 串行 + readonly 并行 + dependencies 串行两段」：仍触发 ② 的两类失败。
  // 结论：E2E 有状态 + 时序敏感，硬并行引入 flaky；维持串行 150s 全绿。若要再提速，
  // 正确杠杆是改用 `vite build` + `vite preview`（静态产物，无 transform 竞争）而非 dev server，
  // 或把 visual 与数据解耦——那是独立重构，不在本次「调参」范围。
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
      // 不再注入 E2E_RESET=1：复用常驻 e2e 库，由 e2e_db.py 的夹具按类型补足 IN_STOCK
      // 账号，避免每次跑测都 drop+create+重播种子（省 5–15s）。人工/自动化行为一致。
      // reuseExistingServer:false 保证每次强制重启 uvicorn，避免复用错的后端实例。
      command: `ERP_E2E_BACKEND_PORT=${E2E_BACKEND_PORT} bash ../backend/scripts/e2e_backend.sh`,
      url: `http://127.0.0.1:${E2E_BACKEND_PORT}/api/v1/auth/me`,
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
