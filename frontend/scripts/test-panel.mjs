/**
 * 板块测试跑板：按业务域只跑该目录下的用例，替代「每次都全量跑 react 层（758 例 / ~27min）」。
 *
 * 三档测试体系中的第二档「板块测试」：
 *   ①单元测试  test:unit   = vitest --project=fast（纯逻辑、无 DOM、秒级）
 *   ②板块测试  test:panel  = 本脚本（改哪个板块只跑哪个 src/<domain>/**）
 *   ③CI 测试   test:ci     = test-full-sharded --all（全量，只在 CI / 发版前跑）
 *
 * 板块名 = src 下的目录名，自动发现，与文件系统单一事实源，无需手工维护清单。
 *
 * 用法：
 *   node scripts/test-panel.mjs orders                 # 只跑 src/orders 下全部用例
 *   node scripts/test-panel.mjs orders stocks          # 多板块一起跑
 *   node scripts/test-panel.mjs --list                 # 列出可用板块
 *   node scripts/test-panel.mjs orders -- --reporter=dot ...  # 「--」之后原样透传给 vitest
 *
 * 约束：
 *   - 禁裸 npx（项目纪律）：直接调用本地 node_modules/.bin/vitest。
 *   - 分片/分层仍由 vitest.config.ts 的 project 决定；本脚本只做「路径过滤」，
 *     不改变任一文件的归属，故 quick/fast 层文件在按域跑时仍按各自 project 执行。
 */
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";

const SRC = "src";
const EXCLUDED = new Set(["test"]); // 通用夹具/助手目录，不是业务板块

const panels = readdirSync(SRC, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => !EXCLUDED.has(name))
  .sort();

// 支持 `--` 分隔：其前是板块名，其后原样传给 vitest。
const raw = process.argv.slice(2);
const sep = raw.indexOf("--");
const head = sep >= 0 ? raw.slice(0, sep) : raw;
const passthrough = sep >= 0 ? raw.slice(sep + 1) : [];

if (head.length === 0 || head.includes("--list") || head.includes("-l") || head.includes("--help")) {
  console.log("可用板块（src/<板块>）：\n  " + panels.join("\n  "));
  console.log("\n用法：node scripts/test-panel.mjs <板块...> [-- <额外 vitest 参数>]");
  console.log("示例：node scripts/test-panel.mjs orders stocks");
  process.exit(0);
}

const unknown = head.filter((name) => !panels.includes(name));
if (unknown.length > 0) {
  console.error(`未知板块：${unknown.join(", ")}\n可用板块：${panels.join(", ")}`);
  process.exit(1);
}

const targets = head.map((name) => `${SRC}/${name}`);
const bin = process.platform === "win32" ? "node_modules/.bin/vitest.cmd" : "node_modules/.bin/vitest";
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
