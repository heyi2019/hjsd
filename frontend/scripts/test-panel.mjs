/**
 * 板块测试跑板：按业务区域只跑该区域的用例，替代「每次都全量跑 react 层」。
 *
 * 三档测试体系中的第二档「板块测试」：
 *   ①单元测试  test:unit   = vitest --project=fast（纯逻辑、无 DOM、秒级）
 *   ②板块测试  test:panel  = 本脚本（改哪个区域只跑 tests/frontend/<kind>/<区域>/）
 *   ③全量档   test:ci     = test-full-sharded --all（手动 full_suite / 发版收口跑）
 *
 * 板块名 = 区域目录名（system/workbench/business/customer/finance/operations/settings/shared），
 * 由磁盘自动发现，与 tests/frontend/<unit|module>/<区域>/ 单一事实源，无需手工维护清单。
 * 2026-11-04 起测试家在仓库根 tests/frontend/，本脚本以仓库根为基准（vitest 的 root）。
 *
 * 用法：
 *   node scripts/test-panel.mjs business               # 只跑业务中心（unit + module 两层）
 *   node scripts/test-panel.mjs business finance       # 多区域一起跑
 *   node scripts/test-panel.mjs --list                 # 列出可用区域
 *   node scripts/test-panel.mjs business -- --reporter=dot ...  # 「--」之后原样透传给 vitest
 *
 * 约束：
 *   - 禁裸 npx（项目纪律）：直接调用本地 node_modules/.bin/vitest。
 *   - 分片/分层仍由 vitest.config.ts 的 project 决定；本脚本只做「路径过滤」，
 *     不改变任一文件的归属，故 quick/fast 层文件在按区域跑时仍按各自 project 执行。
 */
import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(FRONTEND, "..");
const TESTS = resolve(REPO, "tests", "frontend");
const KINDS = ["unit", "module"];

/** 区域名 = 任意一层下出现过的目录名，交集∪并集都行，这里取并集。 */
const regions = [...new Set(
  KINDS.flatMap((kind) => {
    const dir = resolve(TESTS, kind);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }),
)].sort();

// 支持 `--` 分隔：其前是区域名，其后原样传给 vitest。
const raw = process.argv.slice(2);
const sep = raw.indexOf("--");
const head = sep >= 0 ? raw.slice(0, sep) : raw;
const passthrough = sep >= 0 ? raw.slice(sep + 1) : [];

if (head.length === 0 || head.includes("--list") || head.includes("-l") || head.includes("--help")) {
  console.log("可用区域（tests/frontend/<kind>/<区域>）：\n  " + regions.join("\n  "));
  console.log("\n用法：node scripts/test-panel.mjs <区域...> [-- <额外 vitest 参数>]");
  console.log("示例：node scripts/test-panel.mjs business finance");
  process.exit(0);
}

const unknown = head.filter((name) => !regions.includes(name));
if (unknown.length > 0) {
  console.error(`未知区域：${unknown.join(", ")}\n可用区域：${regions.join(", ")}`);
  process.exit(1);
}

/** 每个区域展开成 unit/ 与 module/ 两层目录（不存在的层自动跳过）。 */
const targets = head.flatMap((name) =>
  KINDS.map((kind) => `tests/frontend/${kind}/${name}`)
    .filter((rel) => existsSync(resolve(REPO, rel))),
);
// 依赖提升到仓库根（npm workspaces）：frontend/node_modules 不再存在，bin 在根上。
const BIN_NAME = process.platform === "win32" ? "vitest.cmd" : "vitest";
const bin = [resolve(REPO, "node_modules/.bin", BIN_NAME), resolve(FRONTEND, "node_modules/.bin", BIN_NAME)]
  .find((candidate) => existsSync(candidate));
if (!bin) {
  console.error("找不到 vitest 可执行文件：先在仓库根执行 npm ci");
  process.exit(2);
}
const args = ["run", ...targets, ...passthrough];

console.log(`板块测试：${head.join(", ")}  →  ${targets.join(" ")}`);
const child = spawn(bin, args, { stdio: "inherit", env: process.env });
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
