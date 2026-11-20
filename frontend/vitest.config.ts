/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM 项目（package.json 带 "type": "module"）下 __dirname 未定义 —— 这是最常见的
// 落地失败点。若项目是 CJS（无 "type": "module"），可改回 resolve(__dirname, ...)。
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// [2026-11-04 结构变更] 前端测试全部迁到仓库根 tests/frontend/<unit|module>/<区域>/，
// 测试基建迁到 tests/fixtures（夹具/桩）与 tests/config（setup/基线）。
// 因此 vitest 的 **root 设成仓库根**，include / exclude / setupFiles 一律以仓库根为基准，
// 与 scripts/test-layers.mjs、test-full-sharded.mjs、manifest-parity.test.ts 同一基准。
// 前提（缺一即挂，2026-11-04 三条对照实验实测）：
//   1) 仓库根有 node_modules（npm workspaces + --install-strategy=hoisted，已落地）
//   2) 配置必须留在本包内（挪到 /tmp 会 @vitejs/plugin-react 解析失败）
//   3) server.fs.allow 必须放开到仓库根，否则包外文件被 Vite 白名单拦
const REPO = path.resolve(here(".."));
const SRC = here("./src");

// React 层固定 4 worker：本地与 CI 保持同一并发口径，避免机器核数变化导致耗时抖动。
// 实测（8 核，56 文件 / 756 例，同机同代码）：
//   react  1 worker 163.5s（三次 164.74/160.84/164.92）
//   react  4 worker 116.6s ← 采纳（每 worker 约吃 2 核，核数/2）
//   react  6 worker 110.8s（-5%，CI 上必超订，收益不可移植）
//   react  8 worker 120.9s ← 反超订回退，证明确实每 worker 要 2 核
//   react  pool:"forks" 4 worker 116.5s（与 threads 打平，不构成改动理由）
// react-deep 同样按核推导（16 文件 / 124 例）：
//   1 worker 45.77s / 2 worker 34.08s / 4 worker 32.65s ← 取 2，边际收益已很小
const CPUS = os.cpus().length;
const REACT_WORKERS = 4;
const DEEP_WORKERS = Math.max(2, Math.floor(CPUS / 4));

// Antd v5 + jsdom reliable test config.
// Three settings are mandatory (see SKILL.md):
//   1. resolve.mainFields forces antd ESM build (antd/es) instead of CJS (antd/lib)
//   2. resolve.alias stubs rc-motion / rc-resize-observer with zero-motion stand-ins
//   3. test.server.deps.inline true -> Vite handles CJS->ESM interop (stubs not dropped)
// fast/quick 清单与 scripts/test-full-sharded.mjs 共用单一事实源（scripts/test-layers.mjs），
// 严禁在本文件另写一份（2026-10-27 实锤：两处漂移致分片脚本 exit 1、test:full 长期不可用）。
import { fastTests, quickTests } from "./scripts/test-layers.mjs";

export default defineConfig({
  root: REPO,
  plugins: [react()],
  // Never inherit a developer machine's .env.local API address in jsdom.
  define: { "import.meta.env.VITE_API_BASE": JSON.stringify("http://127.0.0.1:8123/api") },
  resolve: {
    mainFields: ["module", "jsnext:main", "jsnext"],
    alias: {
      // `@` 指向生产源码、`@fixtures` 指向测试基建，两者是测试文件模块定位的**唯一基准**：
      // import 与 vi.mock 都写别名，测试文件搬到任何位置都不会失效。相对路径的真正危险不是
      // 「解析失败」（那会显式报错），而是「搬家后仍解析到某个存在的文件」——mock 不报错却没
      // 命中被测模块，测试改用真实现，保护静默消失。存量相对路径已于 2026-11-04 清零，
      // 由 unit/system/mock-specifier.test.ts 守着不再新增。
      // 与 @ant-design/* 不冲突：alias 匹配规则是「全等」或「前缀 + '/'」，
      // `@ant-design/icons` 不以 `@/` 开头，不会被 `@` 吃掉。
      "@fixtures": path.join(REPO, "tests", "fixtures"),
      "@": SRC,
      "rc-motion": path.join(REPO, "tests", "fixtures", "motion-stub.tsx"),
      "rc-resize-observer": path.join(REPO, "tests", "fixtures", "resize-observer-stub.tsx"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["tests/config/setup.ts"],
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
      fs: {
        // 测试文件在包外（仓库根 tests/），必须显式放开，否则 /@fs/... 被白名单拦。
        allow: [REPO],
      },
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
          // [2026-11-04 实测] forks → threads：8 文件 / 88 例 27.20s → 19.28s（-29%）。
          // quick 层只有 8 个文件，forks 每个文件起一个进程，Node+jsdom 冷启动成本占大头；
          // threads 复用同一进程池，本层用例之间没有跨文件模块状态依赖。
          // worker 数再往上（4）几乎无收益（19.73s）：单个 14.8s 的重文件就是下界。
          pool: "threads",
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
          include: ["tests/frontend/**/*.{test,spec}.{ts,tsx}"],
          // react 层的 include 覆盖整个 tests/frontend，故必须显式排掉 fast/quick 与 .deep：
          //   - 漏排 fast/quick → 同一文件双跑，四层计数静默错位（manifest-parity 会红）
          //   - 漏排 .deep     → 重型用例混回日常层，反馈从 ~170s 反弹到 ~408s
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            ...fastTests,
            ...quickTests,
            "tests/frontend/**/*.deep.test.{ts,tsx}",
          ],
          // worker 数见文件顶部 REACT_WORKERS（核数 / 2）。jsdom+antd 用例是 CPU 密集型的
          // （每 worker 约吃 2 核），超订会互相拖慢。
          pool: "threads",
          maxWorkers: REACT_WORKERS,
          minWorkers: 1,
        },
      },
      {
        extends: true,
        test: {
          name: "react-deep",
          sequence: { groupOrder: 4 },
          include: ["tests/frontend/**/*.deep.test.{ts,tsx}"],
          // 与 react 同构的 threads 池，但 worker 数按核数取 1/4（8 核 → 2）。
          // [2026-11-04 实测] 单 worker 45.77s → 2 worker 34.08s（-26%），4 worker 32.65s（边际很小）。
          // 注意与「分片」区分：早年把 deep 拆成多个 vitest *进程*（408s）之所以更慢，是每个进程
          // 各自重 transform antd；同一进程池内的多 worker 共享 transform 缓存，不踩这个坑。
          pool: "threads",
          maxWorkers: DEEP_WORKERS,
          minWorkers: 1,
          retry: 0,
        },
      },
    ],
  },
});
