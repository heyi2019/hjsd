/** 限并发全量回归：fast/quick 先单独跑，react 层自动发现全部测试文件并按体量均衡分片，
 *  分片间最多 2 并发、分片内 1 worker（jsdom+antd 稳定边界，见 memory 2026-10-20 实测）。
 *  2026-10-27 重构：react 清单改为自动发现（原硬编码清单落后 44 个新文件，「未分片」守卫
 *  exit 1，test:full 长期不可用）；fast/quick 分层清单改与 vitest.config.ts 共用
 *  scripts/test-layers.mjs 单一事实源，杜绝再次漂移。
 *  2026-10-27 二次重构：`.deep.test.tsx` 重型深度用例剥离为独立层——日常 test:full 不再覆盖
 *  它们（提速日常反馈），由 test:full:deep（夜间/手动）或 test:full:all（发版前完整覆盖）承担。
 *    默认          ：fast + quick + 常规 react（不含 deep）  —— 日常 CI / 里程碑前
 *    --deep-only   ：仅 18 个 .deep 文件                   —— 夜间定时 / 手动深测
 *    --all         ：fast + quick + 常规 react + deep       —— 发版前完整回归 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fastTests, quickTests, matchesAny } from "./test-layers.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const rawArgs = process.argv.slice(2);
const mode = rawArgs.includes("--deep-only") ? "deep-only" : rawArgs.includes("--all") ? "all" : "default";
// 模式标志不传给 vitest，其余参数（如 --reporter）原样透传。
const extraArgs = rawArgs.filter((arg) => arg !== "--deep-only" && arg !== "--all");

// 分片数：react 文件数增长时自动跟随，保持每片 ~8-10 个文件；
// 片数过多会增加进程启动开销，过多过少都失衡，故给上下限。
const SHARD_MIN = 6;
const SHARD_MAX = 10;
// [2026-10-27 实测定案] 并发 3 实验否决：RUN1 >6.5min（比并发 2 的 262.81s 更慢）
// 且 shard-1 直接 exit 1（机制与 10-20 的 4 workers 超时同源：jsdom+antd 重型用例
// 争抢资源触发重试放大）。2 是本机稳定边界，勿再上调；提速走「拆重型用例」路线。
const CONCURRENCY = 2;

const testFilePattern = /\.(test|spec)\.(ts|tsx)$/;
const DEEP_PATTERN = /\.deep\.test\.(ts|tsx)$/;

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
// 常规 react 层 = 既不在 fast/quick、也不是 .deep 重型用例。
const reactFiles = allTestFiles.filter(
  (file) => !fastFiles.includes(file) && !quickFiles.includes(file) && !DEEP_PATTERN.test(file),
);
// .deep 重型深度用例独立成层。
const deepFiles = allTestFiles.filter((file) => DEEP_PATTERN.test(file));

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
const makeShards = (files, label) => {
  if (files.length === 0) return [];
  const shardCount = Math.min(SHARD_MAX, Math.max(SHARD_MIN, Math.ceil(files.length / 10)));
  const weighted = files
    .map((file) => ({ file, size: statSync(join(process.cwd(), file)).size }))
    .sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
  const shards = Array.from({ length: shardCount }, () => ({ files: [], total: 0 }));
  for (const { file, size } of weighted) {
    const lightest = shards.reduce((min, shard) => (shard.total < min.total ? shard : min), shards[0]);
    lightest.files.push(file);
    lightest.total += size;
  }
  shards.forEach((shard) => shard.files.sort());
  return shards;
};

const reactShards = makeShards(reactFiles, "react");
const deepShards = makeShards(deepFiles, "deep");

// 单 job 超时保护：jsdom+antd 测试中偶发「waitFor 永远等不到元素」会让 worker 进程卡死，
// 若不保护会冻结整个分片脚本（2026-10-27 实测 test:full 卡 9 分钟无退出）。
// 用 Node 内部 setTimeout + child.kill 兜底（macOS 无系统 timeout 命令）。
const run = (name, args, timeoutMs = 0) => new Promise((resolve, reject) => {
  const child = spawn(npm, args, { stdio: "inherit", env: process.env });
  const startedAt = performance.now();
  let timer;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${name} 超时（${Math.round(timeoutMs / 1000)}s），已 SIGTERM 终止`));
    }, timeoutMs);
  }
  child.on("error", reject);
  child.on("close", (code, signal) => {
    if (timer) clearTimeout(timer);
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    if (code === 0) {
      console.log(`✓ ${name} 完成 (${elapsed}s)`);
      resolve();
    } else {
      reject(new Error(`${name} 退出：${code ?? signal}（${elapsed}s）`));
    }
  });
});

// 各层超时阈值（秒）：fast/quick 轻量；shard 内单文件最重约 60s、LPT 装箱后单 shard 余量充足，
// 150s 留足余量且能在挂起时快速暴露坏文件，而非无限卡死。
const TIMEOUT = { fast: 60_000, quick: 150_000, shard: 150_000 };

// 日常层（default / all）含 fast + quick + 常规 react；deep-only 仅 deep。
const jobs = [];
if (mode !== "deep-only") {
  jobs.push(["fast", ["run", "test:fast", "--", "--reporter=dot", ...extraArgs], TIMEOUT.fast]);
  jobs.push(["quick", ["run", "test:quick", "--", "--reporter=dot", ...extraArgs], TIMEOUT.quick]);
  for (const [index, shard] of reactShards.entries()) {
    jobs.push([
      `react-shard-${index + 1}(${shard.files.length}文件)`,
      ["run", "test:react", "--", "--retry=0", "--reporter=dot", "--maxWorkers=1", ...extraArgs, ...shard.files],
      TIMEOUT.shard,
    ]);
  }
}
if (mode !== "default") {
  for (const [index, shard] of deepShards.entries()) {
    jobs.push([
      `deep-shard-${index + 1}(${shard.files.length}文件)`,
      ["run", "test:react", "--", "--retry=0", "--reporter=dot", "--maxWorkers=1", ...extraArgs, ...shard.files],
      TIMEOUT.shard,
    ]);
  }
}

const startedAt = performance.now();
const layerDesc = mode === "deep-only"
  ? `deep-only：18 个 .deep 重型文件`
  : mode === "all"
    ? `全量（含 deep）：fast ${fastFiles.length} / quick ${quickFiles.length} / react ${reactFiles.length} / deep ${deepFiles.length}`
    : `日常（不含 deep）：fast ${fastFiles.length} / quick ${quickFiles.length} / react ${reactFiles.length}（deep ${deepFiles.length} 移出，由 test:full:deep 承担）`;
console.log(
  `${layerDesc}，片间最多 ${CONCURRENCY} 并发`,
);
const failures = [];
// fast / quick 先于 react/deep 串行跑完，确保轻量快环先出结果。
for (const [name, args, timeout] of jobs.slice(0, mode === "deep-only" ? 0 : 2)) {
  try {
    await run(name, args, timeout);
  } catch (error) {
    failures.push({ name, error });
  }
}

let nextJob = jobs.length > 0 && jobs[0][0] === "fast" ? 2 : 0;
const worker = async () => {
  while (nextJob < jobs.length) {
    const index = nextJob;
    nextJob += 1;
    const [name, args, timeout] = jobs[index];
    try {
      await run(name, args, timeout);
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
  console.log(`回归通过（${mode}），总耗时 ${((performance.now() - startedAt) / 1000).toFixed(2)} 秒`);
}
