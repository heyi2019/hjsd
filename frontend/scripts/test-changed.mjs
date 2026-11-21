/**
 * 按变更自动选区域：读 git 工作区变更，只跑被改动区域的用例。
 * 与后端 `run_regression.py changed`（按 git 变更自动选分组）语义对齐，补齐前端缺口。
 *
 * 三档测试体系（2026-11-02 何一裁决）：
 *   ①单元测试  test:unit     = vitest --project=fast（纯逻辑、无 DOM、秒级）
 *   ②板块测试  test:panel    = 手填区域；test:changed = 自动从 git 变更推断区域
 *   ③全量档   test:ci       = 全量（含 deep），手动 full_suite / 发版收口跑
 *
 * 用法：
 *   node scripts/test-changed.mjs                # 按 git 变更自动跑对应区域
 *   node scripts/test-changed.mjs --list         # 只打印将执行的命令，不跑
 *   node scripts/test-changed.mjs -- --reporter=dot   # 「--」之后原样透传 vitest
 *
 * CI（frontend-gate）通过 TEST_CHANGED_PATHS 注入本次 commit diff 作为变更源：
 * checkout 后工作区恒为干净，靠 git status 会误判成「无前端变更」。
 *
 * 选档规则（2026-11-04 起测试家在仓库根 tests/frontend/）：
 *   - 变更落在 `frontend/src/<domain>/` → 跑该 domain 对应的区域（tests/frontend/<kind>/<区域>）
 *   - 变更落在 `tests/frontend/**`       → 跑变更所在的区域
 *   - 变更落在 `tests/fixtures|config/`  → 夹具/配置影响全部用例，降级跑 quick 档
 *   - 变更落在壳层 `frontend/src/app/`、公共层 `frontend/src/shared/` → 降级跑 quick 档
 *   - 变更落在分层/构建配置（vitest.config.ts、scripts/test-*.mjs、vite.config.ts、
 *     tsconfig*.json、package.json）→ 分层本身变了，降级跑 quick 档
 *   - 无前端/测试变更                → 直接退出 0
 *
 * 已知局限（故意不掩盖）：按区域选测只能覆盖「本区域测试」，跨域耦合（例如改 orders
 * 却由 workbench/WorkbenchPage.test.tsx 断言）测不到。改动跨多域或涉及公共层时，脚本会
 * 主动降级到 quick 档；仍不确定时请直接 `npm run test:quick`。
 *
 * 约束：禁裸 npx（项目纪律），直接调用本地 node_modules/.bin/vitest。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(FRONTEND, "..");
const TESTS_FE = resolve(REPO, "tests", "frontend");
const KINDS = ["unit", "module"];

/** 这些路径一变，分层/构建前提就变了，按区域选测没有意义。 */
const STRUCTURAL = new Set([
  "package.json",
  "vitest.config.ts",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "scripts/test-layers.mjs",
  "scripts/test-panel.mjs",
  "scripts/test-changed.mjs",
  "scripts/test-full-sharded.mjs",
]);

/** src 目录 → 区域。新增 src 目录必须在此登记，否则该目录的改动会被判成「未落在业务板块内」。 */
const SRC_DOMAIN_TO_REGION = {
  app: "workbench",
  business: "business",
  orders: "business",
  stocks: "business",
  installments: "business",
  "customer-center": "customer",
  pools: "finance",
  rebates: "finance",
  reporting: "operations",
  imports: "operations",
  "field-definitions": "settings",
  users: "settings",
  policy: "settings",
  shared: "shared",
  auth: "system",
  audit: "system",
  attachments: "system",
  notifications: "system",
};

/** 这些 src 目录被全站依赖，改动必须放大到 quick 档。 */
const GLOBAL_DOMAINS = new Set(["app", "shared"]);

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
      "按 git 工作区变更自动选择要跑的区域（tests/frontend/<kind>/<区域>）。",
      "改动涉及 app/shared、夹具或分层配置时自动降级为 quick 档。",
    ].join("\n"),
  );
  process.exit(0);
}

if (unknownFlags.length > 0) {
  console.error(`未知参数：${unknownFlags.join(", ")}（本脚本不接受手填区域，请用 test:panel）`);
  process.exit(1);
}

/** `git status --short` 的路径列：处理重命名 `old -> new`，取新路径。 */
function changedPaths() {
  // `TEST_CHANGED_PATHS`（逗号分隔，仓库根相对路径）两种合法来源：
  //   ① 本地自测/演练：显式喂路径，验证「无变更 / 选区域 / 降级」三条分支；
  //   ② GitHub Actions：CI checkout 后 git status 恒为空，由 frontend-gate 计算
  //      commit diff 并注入，否则会误判成「无前端变更」而跳过全部测试。
  // 本地正常使用时不要设置，以免绕开真实 git 状态。
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

/** 仓库根相对路径（tests/… 与 frontend/… 同一坐标系）。 */
const repoChanges = changedPaths().filter((path) => path.startsWith("frontend/") || path.startsWith("tests/"));

if (repoChanges.length === 0) {
  console.log("未发现前端/测试变更，无需跑前端测试。");
  process.exit(0);
}

const regions = new Set();
let globalReason = null;

for (const path of repoChanges) {
  const inFrontend = path.startsWith("frontend/");
  const rel = inFrontend ? path.slice("frontend/".length) : path;

  // 测试基建：夹具与配置改动影响全部用例，收窄必漏。
  if (!inFrontend && /^tests\/(fixtures|config)\//.test(path)) {
    globalReason = `${path}（测试基建变更，影响全部用例）`;
    break;
  }

  // 测试文件自身：跑它所在区域。
  if (!inFrontend && path.startsWith("tests/frontend/")) {
    const parts = path.split("/"); // tests / frontend / <kind> / <区域> / file
    const region = parts[3];
    if (region && KINDS.includes(parts[2])) regions.add(region);
    continue;
  }

  if (!inFrontend) continue;

  if (STRUCTURAL.has(rel)) {
    globalReason = `${rel}（分层/构建配置变更）`;
    break;
  }
  if (!rel.startsWith("src/")) continue;
  const domain = rel.split("/")[1];
  if (!domain) continue;
  if (GLOBAL_DOMAINS.has(domain)) {
    globalReason = `src/${domain}/（全站依赖，按区域选测会漏）`;
    break;
  }
  const region = SRC_DOMAIN_TO_REGION[domain];
  if (!region) {
    globalReason = `src/${domain}/（未登记区域的 src 目录，按区域选测会漏）`;
    break;
  }
  regions.add(region);
}

/** 区域 → 实际要跑的目录（unit/module 两层，存在才跑）。 */
const targetsOf = (names) =>
  names.flatMap((name) =>
    KINDS.map((kind) => `tests/frontend/${kind}/${name}`).filter((rel) => existsSync(resolve(REPO, rel))),
  );

// 依赖提升到仓库根（npm workspaces）：frontend/node_modules 不再存在，bin 在根上。
const BIN_NAME = process.platform === "win32" ? "vitest.cmd" : "vitest";
const bin = [resolve(REPO, "node_modules/.bin", BIN_NAME), resolve(FRONTEND, "node_modules/.bin", BIN_NAME)]
  .find((candidate) => existsSync(candidate));
if (!bin) {
  console.error("找不到 vitest 可执行文件：先在仓库根执行 npm ci");
  process.exit(2);
}

const runNpm = (script, label) => {
  if (listOnly) {
    console.log(`\n将执行：npm run ${script}`);
    process.exit(0);
  }
  console.log(`降级为 ${label}：命中 ${globalReason}`);
  const child = spawn("npm", ["run", script, ...(passthrough.length ? ["--", ...passthrough] : [])], {
    cwd: FRONTEND,
    stdio: "inherit",
    env: process.env,
  });
  child.on("error", (error) => {
    console.error(`无法启动 ${label}：${error.message}`);
    process.exit(1);
  });
  child.on("close", (code, signal) => {
    if (signal) {
      console.error(`${label} 被信号 ${signal} 终止`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
};

if (globalReason) {
  runNpm("test:quick", "quick 档");
} else if (regions.size === 0) {
  console.log(
    `前端变更未落在测试可定位的区域（${repoChanges.slice(0, 5).join(", ")}${repoChanges.length > 5 ? " …" : ""}），无需跑板块测试。`,
  );
  process.exit(0);
} else {
  const selected = [...regions].sort();
  const targets = targetsOf(selected);
  const args = ["run", ...targets, ...passthrough];
  console.log(`按变更选中区域：${selected.join(", ")}  →  ${targets.join(" ")}`);
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
