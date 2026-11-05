/**
 * 执行单个 react-deep 分片。
 *
 * 分片 = 业务区域（tests/frontend/module/<区域>/*.deep.test.tsx），从磁盘自动发现，
 * 不再手写文件清单——2026-11-04 搬家时手写清单是主要返工点（改目录就得同步改 16 行）。
 * 本地可逐片执行，CI 通过矩阵并行执行；原 test:full:deep 仍负责单进程全量深度回归。
 */
import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(FRONTEND, "..");
const MODULE_ROOT = join(REPO, "tests", "frontend", "module");
const DEEP = /\.deep\.test\.tsx?$/;

/** 区域 → 该区域的 deep 文件（相对仓库根，vitest 以仓库根为 root）。 */
const SHARDS = {};
if (existsSync(MODULE_ROOT)) {
  for (const entry of readdirSync(MODULE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = readdirSync(join(MODULE_ROOT, entry.name))
      .filter((name) => DEEP.test(name))
      .map((name) => `tests/frontend/module/${entry.name}/${name}`)
      .sort();
    if (files.length > 0) SHARDS[entry.name] = files;
  }
}

const total = Object.values(SHARDS).reduce((sum, files) => sum + files.length, 0);
if (total === 0) {
  console.error(`未发现任何 .deep 用例（扫描根 ${MODULE_ROOT}）：核对 deep 文件是否被搬走或改名`);
  process.exit(2);
}

const shard = process.argv[2];
if (!shard || !Object.hasOwn(SHARDS, shard)) {
  console.error(`用法：npm run test:react-deep:shard -- <${Object.keys(SHARDS).join("|")}>`);
  process.exit(2);
}

const files = SHARDS[shard];
const missing = files.filter((file) => !existsSync(resolve(REPO, file)));
if (missing.length > 0) {
  console.error(`deep 分片 ${shard} 包含不存在的测试文件：\n${missing.join("\n")}`);
  process.exit(2);
}

// 禁裸 npx（项目纪律）：直接调用本地 bin。依赖已提升到仓库根（npm workspaces），
// frontend/node_modules 不再存在，故优先找根上的 bin，再退回包内。
const BIN_NAME = process.platform === "win32" ? "vitest.cmd" : "vitest";
const runner = [resolve(REPO, "node_modules/.bin", BIN_NAME), resolve(FRONTEND, "node_modules/.bin", BIN_NAME)]
  .find((candidate) => existsSync(candidate));
if (!runner) {
  console.error("找不到 vitest 可执行文件：先在仓库根执行 npm ci（依赖已提升到根 node_modules）");
  process.exit(2);
}
console.log(`react-deep 分片 ${shard}：${files.length} 个文件（全部 deep 共 ${total} 个）`);
const child = spawn(
  runner,
  ["run", "--project=react-deep", "--retry=0", "--reporter=dot", ...files],
  { cwd: FRONTEND, stdio: "inherit", env: process.env },
);

child.on("error", (error) => {
  console.error(`无法启动 react-deep 分片 ${shard}：${error.message}`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  if (code !== 0) {
    console.error(`react-deep 分片 ${shard} 失败：${code ?? signal}`);
    process.exitCode = code ?? 1;
  } else {
    console.log(`react-deep 分片 ${shard} 通过`);
  }
});
