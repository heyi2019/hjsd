/** 限并发全量回归：fast/quick 先单独跑，react 层自动发现全部测试文件并按体量均衡分片，
 *  分片间最多 2 并发、分片内 1 worker（jsdom+antd 稳定边界，见 memory 2026-10-20 实测）。
 *  2026-10-27 重构：react 清单改为自动发现（原硬编码清单落后 44 个新文件，「未分片」守卫
 *  exit 1，test:full 长期不可用）；fast/quick 分层清单改与 vitest.config.ts 共用
 *  scripts/test-layers.mjs 单一事实源，杜绝再次漂移。 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fastTests, quickTests, matchesAny } from "./test-layers.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const extraArgs = process.argv.slice(2);

// 分片数：react 文件数增长时自动跟随，保持每片 ~8-10 个文件；
// 片数过多会增加进程启动开销，过多过少都失衡，故给上下限。
const SHARD_MIN = 6;
const SHARD_MAX = 10;
// [2026-10-27 实测定案] 并发 3 实验否决：RUN1 >6.5min（比并发 2 的 262.81s 更慢）
// 且 shard-1 直接 exit 1（机制与 10-20 的 4 workers 超时同源：jsdom+antd 重型用例
// 争抢资源触发重试放大）。2 是本机稳定边界，勿再上调；提速走「拆重型用例」路线。
const CONCURRENCY = 2;

const testFilePattern = /\.(test|spec)\.(ts|tsx)$/;
const collectTestFiles = (directory, prefix = "src") => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const absolute = join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return collectTestFiles(absolute, relative);
    return testFilePattern.test(entry.name) ? [relative] : [];
  });

const allTestFiles = collectTestFiles(join(process.cwd(), "src")).sort();
const fastFiles = allTestFiles.filter((file) => matchesAny(file, fastTests));
const quickFiles = allTestFiles.filter((file) => matchesAny(file, quickTests));
const reactFiles = allTestFiles.filter((file) => !fastFiles.includes(file) && !quickFiles.includes(file));

if (allTestFiles.length === 0) {
  console.error("未发现任何测试文件，检查运行目录是否为 frontend/");
  process.exit(1);
}
if (fastFiles.length === 0 || quickFiles.length === 0) {
  console.error(`分层清单与实际文件不匹配：fast=${fastFiles.length}，quick=${quickFiles.length}，请核对 scripts/test-layers.mjs 与 vitest.config.ts`);
  process.exit(1);
}

// LPT 装箱：按文件字节大小（粗略耗时代理，含 mock/交互复杂度相关性）从大到小，
// 依次放入当前累计最小的分片；排序确定，保证分片可复现。
const shardCount = Math.min(SHARD_MAX, Math.max(SHARD_MIN, Math.ceil(reactFiles.length / 10)));
const weighted = reactFiles
  .map((file) => ({ file, size: statSync(join(process.cwd(), file)).size }))
  .sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
const shards = Array.from({ length: shardCount }, () => ({ files: [], total: 0 }));
for (const { file, size } of weighted) {
  const lightest = shards.reduce((min, shard) => (shard.total < min.total ? shard : min), shards[0]);
  lightest.files.push(file);
  lightest.total += size;
}
shards.forEach((shard, index) => shard.files.sort());

const run = (name, args) => new Promise((resolve, reject) => {
  const child = spawn(npm, args, { stdio: "inherit", env: process.env });
  child.on("error", reject);
  child.on("close", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`${name} 退出：${code ?? signal}`));
  });
});

const jobs = [
  ["fast", ["run", "test:fast", "--", "--reporter=dot", ...extraArgs]],
  ["quick", ["run", "test:quick", "--", "--reporter=dot", ...extraArgs]],
  ...shards.map((shard, index) => [
    `react-shard-${index + 1}(${shard.files.length}文件)`,
    ["run", "test:react", "--", "--retry=0", "--reporter=dot", "--maxWorkers=1", ...extraArgs, ...shard.files],
  ]),
];

const startedAt = performance.now();
console.log(
  `共 ${allTestFiles.length} 文件：fast ${fastFiles.length} / quick ${quickFiles.length} 串行，`
  + `react ${reactFiles.length} 文件均衡为 ${shardCount} 片，片间最多 ${CONCURRENCY} 并发`,
);
const failures = [];
for (const [name, args] of jobs.slice(0, 2)) {
  try {
    await run(name, args);
  } catch (error) {
    failures.push({ name, error });
  }
}

let nextJob = 2;
const worker = async () => {
  while (nextJob < jobs.length) {
    const index = nextJob;
    nextJob += 1;
    const [name, args] = jobs[index];
    try {
      await run(name, args);
    } catch (error) {
      failures.push({ name, error });
    }
  }
};
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`${name} 失败：${error.message}`);
  process.exitCode = 1;
} else {
  console.log(`完整分片回归通过，总耗时 ${((performance.now() - startedAt) / 1000).toFixed(2)} 秒`);
}
