/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// ESM 项目（package.json 带 "type": "module"）下 __dirname 未定义 —— 这是最常见的
// 落地失败点。若项目是 CJS（无 "type": "module"），可改回 resolve(__dirname, ...)。
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// 轻量纯逻辑测试可以安全并行；涉及大量 antd/jsdom 交互的页面测试共用
// 一个 worker，避免多个大型 DOM 树同时争抢机器资源导致超时和重试。
const fastTests = [
  "src/test/fixtures.test.ts",
  "src/accounts/inventory-export.test.ts",
  "src/accounts/inventory-logic.test.ts",
  "src/shared/api/*.test.ts",
  "src/shared/lib/*.test.ts",
  "src/vite.config.test.ts",
];

// 日常反馈层：覆盖登录、权限、主工作台、订单写路径、报表和设置等关键面，
// 不包含库存/客户/资金等长链路全量页面回归。
const quickTests = [
  "src/app/DashboardPage.test.tsx",
  "src/app/DashboardPage.interactions.test.tsx",
  "src/auth/LoginPage.test.tsx",
  "src/auth/UserCenterPage.test.tsx",
  "src/field-definitions/SettingsPage.test.tsx",
  "src/orders/CreateBusinessModal.test.tsx",
  "src/orders/CreateBusinessModal.distribution.test.tsx",
  "src/policy/PolicySettingsPanel.test.tsx",
  "src/reporting/ReportsPage.test.tsx",
  "src/shared/state/session.test.tsx",
];

// Antd v5 + jsdom reliable test config.
// Three settings are mandatory (see SKILL.md):
//   1. resolve.mainFields forces antd ESM build (antd/es) instead of CJS (antd/lib)
//   2. resolve.alias stubs rc-motion / rc-resize-observer with zero-motion stand-ins
//   3. test.server.deps.inline true -> Vite handles CJS->ESM interop (stubs not dropped)
export default defineConfig({
  plugins: [react()],
  // Never inherit a developer machine's .env.local API address in jsdom.
  define: { "import.meta.env.VITE_API_BASE": JSON.stringify("http://127.0.0.1:8123/api/v1") },
  resolve: {
    mainFields: ["module", "jsnext:main", "jsnext"],
    alias: {
      "rc-motion": here("./src/test/motion-stub.tsx"),
      "rc-resize-observer": here("./src/test/resize-observer-stub.tsx"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // 单个用例超时放宽：写路径重型用例（大量 userEvent 交互 + antd Modal）临界耗时较长，
    // 资源紧张时易被拖超；给 60s 余量避免偶发误判。
    testTimeout: 60000,
    // 重试 1 次：消除重型用例在机器负载波动下的偶发超时（重跑即过），真失败两次仍暴露。
    retry: 1,
    // Vitest 5 已移除 poolOptions；单 worker 避免 jsdom + antd 用例互相争抢资源。
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    server: {
      deps: {
        // [2026-10-20 实测更正] 旧注释把失败归因于「esbuild 预打包不应用 resolve.alias、inline 非
        // true 即触发优化器崩溃」——该归因错误。真实机制：Vitest 5.0.3 的 esbuild 优化器默认完全关闭
        // （deps.optimizer.ssr.enabled ??= false，resolveOptimizerConfig 返回 disabled），
        // server.deps.inline 只决定「外部化（node 原生 import）还是内联（Vite transform）」，
        // 与预打包无关。外部化的代价是 node 原生 import 绕过 resolve.alias 与 vi.mock。
        // 故整树内联，确保 alias 桩与 vi.mock 对 antd 子路径生效。
        // 已实测并否决的两条路（勿再试）：
        //   1) 全外部化（留空/undefined）：@ant-design/cssinjs no-op 桩失效 = 丢失 aa3885a 的 5×
        //      提速来源，且 InventoryPanel.sale 等交互用例确定性失败。
        //   2) 用 theme.token.motion=false 替换 rc-motion 桩：功能可行（Modal/Tab/静态 Modal.confirm
        //      均绿），但全量反而更慢（基线 78.85s → 94~100s）：真实 rc-motion 比桩多出的 transform
        //      成本大于省下的 transitionend 等待。桩本就是最优解。
        // 注：不能写 inline:false —— matchPattern 会对 false 做 for...of，抛 TypeError。
        inline: true,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "fast",
          // Vitest 5 多 project 同时运行（如 `vitest run`）必须各自声明唯一 groupOrder，
          // 否则报 "Provide unique 'sequence.groupOrder' for them"。
          sequence: { groupOrder: 1 },
          include: fastTests,
          pool: "forks",
          maxWorkers: 3,
          minWorkers: 1,
          retry: 0,
        },
      },
      {
        extends: true,
        test: {
          name: "quick",
          sequence: { groupOrder: 2 },
          include: quickTests,
          pool: "forks",
          maxWorkers: 2,
          minWorkers: 1,
          retry: 0,
        },
      },
      {
        extends: true,
        test: {
          name: "react",
          sequence: { groupOrder: 3 },
          include: ["src/**/*.{test,spec}.{ts,tsx}"],
          exclude: [
            "src/test/fixtures.test.ts",
            "src/accounts/inventory-export.test.ts",
            "src/accounts/inventory-logic.test.ts",
            "src/shared/api/*.test.ts",
            "src/shared/lib/*.test.ts",
            "src/vite.config.test.ts",
            ...quickTests,
          ],
          // [2026-10-20 实测] forks → threads：酸测 5 文件 31 用例中位数 29.37s → 25.57s（~13%），
          // 且两组区间不重叠（threads 24.17~26.96 vs forks 27.62~31.12）。threads 复用 worker
          // 线程而非每次 fork 进程，省下进程创建开销；正确性零回归（31/31 两次全绿）。
          pool: "threads",
          maxWorkers: 1,
          minWorkers: 1,
        },
      },
    ],
  },
});
