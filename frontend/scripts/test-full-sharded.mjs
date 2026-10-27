/** 限并发全量回归：fast/quick 先单独跑，react 层按模式跑（单进程、共享 vite transform 缓存）。
 *  关键提速（2026-10-27）：react/deep 不再切成多个子进程 shard —— 每个子进程是独立的 vite
 *  实例，会各自重 transform antd/react，把单进程 249s（78 文件）放大到分片 408s（69 非 deep）。
 *  改为「每层一个 vitest 进程」后，同层文件共享一份 transform 缓存，日常层由 ~408s 降至 ~170s。
 *  分片间最多 2 并发（jsdom+antd 稳定边界，见 memory 2026-10-20 实测；并发 3 实验已否决）。
 *
 *  模式：
 *    默认          ：fast + quick + 常规 react（不含 deep）  —— 日常 CI / 里程碑前
 *    --deep-only   ：仅 react-deep（.deep 重型文件）         —— 夜间定时 / 手动深测
 *    --all         ：fast + quick + 常规 react + react-deep   —— 发版前完整回归
 *  react / react-deep 的项目归属与 deep 剥离口径在 vitest.config.ts（react.exclude + react-deep
 *  项目）单一事实源，本脚本只按 --project 触发，不另写文件清单。 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fastTests, quickTests, matchesAny } from "./test-layers.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const rawArgs = process.argv.slice(2);
const mode = rawArgs.includes("--deep-only") ? "deep-only" : rawArgs.includes("--all") ? "all" : "default";
// 模式标志不传给 vitest，其余参数（如 --reporter）原样透传。
const extraArgs = rawArgs.filter((arg) => arg !== "--deep-only" && arg !== "--all");

// [2026-10-27 实测定案] 并发 3 实验否决：RUN1 >6.5min（比并发 2 的 262.81s 更慢）且 shard-1
// 直接 exit 1（机制与 10-20 的 4 workers 超时同源）。2 是本机稳定边界，勿再上调。
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
// .deep 重型深度用例独立成 react-deep 项目层。
const deepFiles = allTestFiles.filter((file) => DEEP_PATTERN.test(file));

if (allTestFiles.length === 0) {
  console.error("未发现任何测试文件，检查运行目录是否为 frontend/");
  process.exit(1);
}
if (fastFiles.length === 0 || quickFiles.length === 0) {
  console.error(`分层清单与实际文件不匹配：fast=${fastFiles.length}，quick=${quickFiles.length}，请核对 scripts/test-layers.mjs 与 vitest.config.ts`);
  process.exit(1);
}

// 单 job 超时保护：jsdom+antd 测试中偶发「waitFor 永远等不到元素」会让 worker 进程卡死，
// 若不保护会冻结整个脚本（2026-10-27 实测 test:full 卡 9 分钟无退出）。
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

// 各层超时阈值（秒）：fast/quick 轻量；react/deep 单进程跑全部文件，单文件最重约 60s，
// 整层余量充足，600s 既能容纳重型用例也不至于无限卡死。
const TIMEOUT = { fast: 60_000, quick: 150_000, react: 600_000, deep: 600_000 };

// 日常层（default / all）含 fast + quick + 常规 react；deep-only 仅 react-deep；all 再加 react-deep。
// react/deep 用 --project 触发（vitest.config.ts 单一事实源），单进程共享 transform 缓存。
const jobs = [];
if (mode !== "deep-only") {
  jobs.push(["fast", ["run", "test:fast", "--", "--reporter=dot", ...extraArgs], TIMEOUT.fast]);
  jobs.push(["quick", ["run", "test:quick", "--", "--reporter=dot", ...extraArgs], TIMEOUT.quick]);
  jobs.push([
    "react（非 deep，单进程）",
    ["run", "test:react", "--", "--retry=0", "--reporter=dot", ...extraArgs],
    TIMEOUT.react,
  ]);
}
if (mode !== "default") {
  jobs.push([
    "react-deep（.deep 重型，单进程）",
    ["run", "test:react-deep", "--", "--retry=0", "--reporter=dot", ...extraArgs],
    TIMEOUT.deep,
  ]);
}

const startedAt = performance.now();
const layerDesc = mode === "deep-only"
  ? `deep-only：react-deep ${deepFiles.length} 个 .deep 重型文件`
  : mode === "all"
    ? `全量（含 deep）：fast ${fastFiles.length} / quick ${quickFiles.length} / react ${reactFiles.length} / react-deep ${deepFiles.length}`
    : `日常（不含 deep）：fast ${fastFiles.length} / quick ${quickFiles.length} / react ${reactFiles.length}（react-deep ${deepFiles.length} 移出，由 test:full:deep 承担）`;
console.log(
  `${layerDesc}，层间最多 ${CONCURRENCY} 并发`,
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
