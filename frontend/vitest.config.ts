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
        // 为让 rc-motion / rc-resize-observer 的零动效桩（src/test/*-stub.tsx，经
        // resolve.alias 重定向）不被 esbuild 预打包流程丢掉，必须禁用整树预打包。
        // 代价：34 个 react 文件各自重 transform 整棵 antd ESM → 全量 ~5min。
        // 根治（恢复预打包同时保桩）风险高，已原型验证回归，暂搁置，见 MEMORY.md。
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
          pool: "forks",
          maxWorkers: 1,
          minWorkers: 1,
        },
      },
    ],
  },
});
