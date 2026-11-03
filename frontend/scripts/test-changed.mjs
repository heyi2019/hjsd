/**
 * 按变更自动选板块：读 git 工作区变更，只跑被改动板块的用例。
 * 与后端 `run_regression.py changed`（按 git 变更自动选分组）语义对齐，补齐前端缺口。
 *
 * 三档测试体系（2026-11-02 何一裁决）：
 *   ①单元测试  test:unit     = vitest --project=fast（纯逻辑、无 DOM、秒级，~7s/67 例）
 *   ②板块测试  test:panel    = 手填板块；test:changed = 自动从 git 变更推断板块
 *   ③CI 测试   test:ci       = 全量（含 deep），只在 CI / 发版前跑
 *
 * 用法：
 *   node scripts/test-changed.mjs                # 按 git 变更自动跑对应板块
 *   node scripts/test-changed.mjs --list         # 只打印将执行的命令，不跑
 *   node scripts/test-changed.mjs -- --reporter=dot   # 「--」之后原样透传 vitest
 *
 * 选档规则：
 *   - 变更落在 `src/<domain>/`      → 跑 `src/<domain>`（可多个）
 *   - 变更落在 `src/app/`           → 壳层聚合所有业务域，改它降级跑 quick 档
 *   - 变更落在 `src/shared/`        → 公共层被所有板块依赖，收窄会漏测，降级跑 quick 档
 *   - 变更落在 `src/test/`          → 夹具改动影响全部用例，降级跑 quick 档
 *   - 变更落在分层/构建配置（vitest.config.ts、scripts/test-layers.mjs、vite.config.ts、
 *     tsconfig*.json、package.json）→ 分层本身变了，降级跑 quick 档
 *   - 无前端变更                    → 直接退出 0
 *
 * 已知局限（故意不掩盖）：按域选测只能覆盖「本域测试」，跨域耦合（例如改 orders
 * 却由 app/DashboardPage.test.tsx 断言）测不到。改动跨多域或涉及公共层时，脚本会
 * 主动降级到 quick 档；仍不确定时请直接 `npm run test:quick`。
 *
 * 约束：禁裸 npx（项目纪律），直接调用本地 node_modules/.bin/vitest。
 */
import { execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(FRONTEND, "..");

/** 这些路径一变，分层/构建前提就变了，按域选测没有意义。 */
const STRUCTURAL = new Set([
  "package.json",
  "vitest.config.ts",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.node.json",
  "scripts/test-layers.mjs",
  "scripts/test-panel.mjs",
  "scripts/test-changed.mjs",
  "scripts/test-full-sharded.mjs",
]);

/** 这些 src 子目录被全站依赖，改动必须放大到 quick 档。 */
const GLOBAL_DOMAINS = new Set(["app", "shared", "test"]);

const raw = process.argv.slice(2);
const sep = raw.indexOf("--");
const head = sep >= 0 ? raw.slice(0, sep) : raw;
const passthrough = sep >= 0 ? raw.slice(sep + 1) : [];
const listOnly = head.includes("--list") || head.includes("-l");
const unknownFlags = head.filter((arg) => !["--list", "-l", "--help"].includes(arg));

if (head.includes("--help")) {
  console.log(
    [
      "用法：node scripts/test-changed.mjs [--list] [-- <额外 vitest 参数>]",
      "",
      "按 git 工作区变更自动选择要跑的板块（src/<domain>）。",
      "改动涉及 app/shared/test 或分层配置时自动降级为 quick 档。",
    ].join("\n"),
  );
  process.exit(0);
}

if (unknownFlags.length > 0) {
  console.error(`未知参数：${unknownFlags.join(", ")}（本脚本不接受手填板块，请用 test:panel）`);
  process.exit(1);
}

const panels = new Set(
  readdirSync(resolve(FRONTEND, "src"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "test"),
);

/** `git status --short` 的路径列：处理重命名 `old -> new`，取新路径。 */
function changedPaths() {
  // `TEST_CHANGED_PATHS`（逗号分隔）仅供脚本自测/演练：正常使用不要设置，
  // 否则会绕开真实 git 状态。用于验证「无变更 / 选板块 / 降级」三条分支。
  const override = process.env.TEST_CHANGED_PATHS;
  if (override !== undefined) {
    return override
      .split(",")
      .map((path) => path.trim())
      .filter(Boolean);
  }
  const out = execFileSync(
    "git",
    ["-C", REPO, "status", "--short", "--untracked-files=all"],
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .filter((line) => line.trim().length > 3)
    .map((line) => line.slice(3).trim())
    .map((path) => (path.includes(" -> ") ? path.split(" -> ").pop().trim() : path))
    .map((path) => path.replace(/^"|"$/g, ""));
}

const frontendChanges = changedPaths()
  .filter((path) => path.startsWith("frontend/"))
  .map((path) => path.slice("frontend/".length));

if (frontendChanges.length === 0) {
  console.log("未发现前端变更，无需跑前端测试。");
  process.exit(0);
}

const domains = new Set();
let globalReason = null;
// `tests/` 是包内纯逻辑测试目录（2026-11-04 从 src/ 迁出）。它的变更不属于任何
// `src/<域>`，旧逻辑会落到「未落在业务板块内 → 什么都不跑」。改为直接跑 fast 档。
const pureTestsChanged = frontendChanges.some((path) => path.startsWith("tests/"));

for (const path of frontendChanges) {
  if (STRUCTURAL.has(path)) {
    globalReason = `${path}（分层/构建配置变更）`;
    break;
  }
  if (!path.startsWith("src/")) continue;
  const domain = path.split("/")[1];
  if (!domain) continue;
  if (GLOBAL_DOMAINS.has(domain)) {
    globalReason = `src/${domain}/（全站依赖，按域选测会漏）`;
    break;
  }
  if (panels.has(domain)) domains.add(domain);
}

const bin = process.platform === "win32" ? "node_modules/.bin/vitest.cmd" : "node_modules/.bin/vitest";

if (globalReason) {
  console.log(`降级为 quick 档：命中 ${globalReason}`);
  if (listOnly) {
    console.log("\n将执行：npm run test:quick");
    process.exit(0);
  }
  const child = spawn("npm", ["run", "test:quick", ...(passthrough.length ? ["--", ...passthrough] : [])], {
    cwd: FRONTEND,
    stdio: "inherit",
    env: process.env,
  });
  child.on("error", (error) => {
    console.error(`无法启动 quick 档：${error.message}`);
    process.exit(1);
  });
  child.on("close", (code, signal) => {
    if (signal) {
      console.error(`quick 档被信号 ${signal} 终止`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
} else if (pureTestsChanged) {
  console.log("命中 frontend/tests/（纯逻辑测试变更）→ 跑 fast 档");
  if (listOnly) {
    console.log("\n将执行：npm run test:fast");
    process.exit(0);
  }
  const child = spawn("npm", ["run", "test:fast", ...(passthrough.length ? ["--", ...passthrough] : [])], {
    cwd: FRONTEND,
    stdio: "inherit",
    env: process.env,
  });
  child.on("error", (error) => {
    console.error(`无法启动 fast 档：${error.message}`);
    process.exit(1);
  });
  child.on("close", (code) => process.exit(code ?? 1));
} else if (domains.size === 0) {
  console.log(
    `前端变更未落在业务板块内（${frontendChanges.slice(0, 5).join(", ")}${frontendChanges.length > 5 ? " …" : ""}），无需跑板块测试。`,
  );
  process.exit(0);
} else {
  const selected = [...domains].sort();
  const targets = selected.map((name) => `src/${name}`);
  const args = ["run", ...targets, ...passthrough];
  console.log(`按变更选中板块：${selected.join(", ")}  →  ${targets.join(" ")}`);
  if (listOnly) {
    console.log(`\n将执行：${bin} ${args.join(" ")}`);
    process.exit(0);
  }
  const child = spawn(bin, args, { cwd: FRONTEND, stdio: "inherit", env: process.env });
  child.on("error", (error) => {
    console.error(`无法启动 vitest：${error.message}`);
    process.exit(1);
  });
  child.on("close", (code, signal) => {
    if (signal) {
      console.error(`vitest 被信号 ${signal} 终止`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}
