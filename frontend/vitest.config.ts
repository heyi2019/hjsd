/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// ESM 项目（package.json 带 "type": "module"）下 __dirname 未定义 —— 这是最常见的
// 落地失败点。若项目是 CJS（无 "type": "module"），可改回 resolve(__dirname, ...)。
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// 轻量纯逻辑测试可以安全并行；涉及大量 antd/jsdom 交互的页面测试共用
// 一个 worker，避免多个大型 DOM 树同时争抢机器资源导致超时和重试。
// 清单本体见 scripts/test-layers.mjs（此处仅解构引入）。

// Antd v5 + jsdom reliable test config.
// Three settings are mandatory (see SKILL.md):
//   1. resolve.mainFields forces antd ESM build (antd/es) instead of CJS (antd/lib)
//   2. resolve.alias stubs rc-motion / rc-resize-observer with zero-motion stand-ins
//   3. test.server.deps.inline true -> Vite handles CJS->ESM interop (stubs not dropped)
// fast/quick 清单与 scripts/test-full-sharded.mjs 共用单一事实源（scripts/test-layers.mjs），
// 严禁在本文件另写一份（2026-10-27 实锤：两处漂移致分片脚本 exit 1、test:full 长期不可用）。
import { fastTests, quickTests } from "./scripts/test-layers.mjs";
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
          // [2026-10-27 提速] .deep 重型深度用例从 react 层剥离，独立成 react-deep 项目，
          // 日常 test:full 不再覆盖（详见 scripts/test-full-sharded.mjs 模式说明）。
          exclude: [
            "src/test/fixtures.test.ts",
            "src/stocks/inventory-export.test.ts",
            "src/stocks/inventory-logic.test.ts",
            "src/shared/api/*.test.ts",
            "src/shared/lib/*.test.ts",
            "src/vite.config.test.ts",
            "src/**/*.deep.test.tsx",
            ...quickTests,
          ],
          // [2026-11-03 实测重定] maxWorkers 1→2 之后机器已升到 8 核，2 worker 只吃到
          // 214% CPU（6 核闲置）。三档实测（91 文件 / 432 用例，同机同代码）：
          //   2 worker 181.89s（cpu 214%）
          //   4 worker 144.62s（cpu 372%）← 采纳，-20%
          //   6 worker 156.72s（cpu 372%）← 反而回退，超订（每 worker 要 2 核）
          // 结论：worker 数取「物理核 / 2」。jsdom+antd 在 4 worker 下 91 文件全绿、
          // 零 retry 触发的失败。新增机器或升配后按此公式重测。
          pool: "threads",
          maxWorkers: 4,
          minWorkers: 1,
        },
      },
      {
        extends: true,
        test: {
          name: "react-deep",
          sequence: { groupOrder: 4 },
          include: ["src/**/*.deep.test.{ts,tsx}"],
          // 与 react 同构：单 worker 避免 jsdom+antd 争抢。deep 重型用例（大量 userEvent
          // 交互 + antd Modal）集中于此层，由 test:full:deep / test:full:all 触发，日常
          // test:full 不含（提速日常反馈）。单进程跑以复用 vite transform 缓存（分片子进程
          // 会各自重 transform antd 致 408s，单进程同层仅需 ~170s）。
          pool: "threads",
          maxWorkers: 1,
          minWorkers: 1,
          retry: 0,
        },
      },
    ],
    // 覆盖率仅在使用 `vitest run --coverage` 时激活，不影响日常测试运行。
    // 量化前端薄弱页用：provider v8（与 esbuild transform 兼容，零额外依赖）。
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text", "json-summary", "json", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/test/**",
        "src/**/*.test.{ts,tsx}",
        "src/**/*.spec.{ts,tsx}",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "src/vite.config.test.ts",
        "**/*.d.ts",
      ],
      thresholds: {
        // 门禁基线（2026-11-03 实测 fast+quick+react 三档聚合）：
        //   lines 82.45 / statements 78.92 / functions 68.86 / branches 75.49（916 例全绿）。
        // 仅 global 聚合阈值，不设 per-file——大量业务页当前覆盖率本就低，per-file 必炸。
        // 缓冲约 2~3pt：真实回归（跌破此线）才失败，正常波动不误伤。
        // CI 仅在 frontend-coverage job 显式跑 --coverage 时才触发本门禁；日常 test:fast/quick/react 不受影响。
        global: {
          lines: 80,
          statements: 76,
          functions: 66,
          branches: 72,
        },
      },
    },
  },
});
