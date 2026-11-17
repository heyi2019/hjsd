/** 分层全量回归脚本：轻量层并行，重型层依次执行，平衡速度与资源占用。 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fastTests, quickTests, matchesAny } from "./test-layers.mjs";
import { runParallelJobs } from "./test-full-sharded-scheduling.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const rawArgs = process.argv.slice(2);
const mode = rawArgs.includes("--deep-only") ? "deep-only" : rawArgs.includes("--all") ? "all" : "default";
// 模式标志不传给 vitest，其余参数（如 --reporter）原样透传。
const extraArgs = rawArgs.filter((arg) => arg !== "--deep-only" && arg !== "--all");

// fast/quick 彼此独立，使用缓冲输出并行；react/deep 保持串行，避免重型 jsdom 层争抢资源。

const testFilePattern = /\.(test|spec)\.(ts|tsx)$/;
const DEEP_PATTERN = /\.deep\.test\.(ts|tsx)$/;

const collectTestFiles = (directory, prefix) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const absolute = join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return collectTestFiles(absolute, relative);
    return testFilePattern.test(entry.name) ? [relative] : [];
  });

// 唯一测试根：仓库根 tests/frontend/（2026-11-04 起组件测试与纯逻辑测试都在这里，
// 包内 src/ 与 frontend/tests/ 已清空，见 tests/README.md）。
// 前缀必须是「相对仓库根」的路径，与 test-layers.mjs 的 glob、vitest root 同一基准；
// 扫错根的后果不是报错，而是文件「既不在 fast 也不在 react」——分层统计永远自洽，
// 但它们再也不会被 test:full 跑到。
const REPO = join(process.cwd(), "..");
const TEST_ROOTS = [
  { directory: join(REPO, "tests", "frontend"), prefix: "tests/frontend" },
];

const allTestFiles = TEST_ROOTS
  .filter(({ directory }) => existsSync(directory))
  .flatMap(({ directory, prefix }) => collectTestFiles(directory, prefix))
  .sort();
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
// 目录在、却一条没收到 = 前缀对不上（比如此前只会静默漏跑）。
if (existsSync(TEST_ROOTS[0].directory) && !allTestFiles.some((file) => file.startsWith("tests/frontend/"))) {
  console.error("tests/frontend 存在但未收集到任何用例：核对 test-layers.mjs 与 test-full-sharded 的前缀基准（仓库根）");
  process.exit(1);
}

// 单 job 超时保护：jsdom+antd 测试中偶发「waitFor 永远等不到元素」会让 worker 进程卡死，
// 若不保护会冻结整个脚本（2026-10-27 实测 test:full 卡 9 分钟无退出）。
// 用 Node 内部 setTimeout + child.kill 兜底（macOS 无系统 timeout 命令）。
// buffered=true 时把子进程输出攒起来、结束后整段带前缀打印：层间并发时 stdio:"inherit"
// 会让两层日志逐行交错，读不出哪条属于哪层（并发只用于 fast/quick，故只这两层走缓冲）。
const run = (name, args, timeoutMs = 0, { buffered = false } = {}) => new Promise((resolve, reject) => {
  const child = spawn(npm, args, {
    stdio: buffered ? ["ignore", "pipe", "pipe"] : "inherit",
    env: process.env,
  });
  let captured = "";
  if (buffered) {
    child.stdout.on("data", (chunk) => { captured += chunk; });
    child.stderr.on("data", (chunk) => { captured += chunk; });
  }
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
    if (captured) {
      // 只在结束时整段吐出，避免与另一层交错。
      process.stdout.write(`┌── ${name} ──\n${captured.replace(/^/gm, "│ ")}\n└── ${name} ──\n`);
    }
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
console.log(`${layerDesc}，fast + quick 并行，react${mode === "all" ? " + react-deep" : ""} 串行`);
const failures = [];
const parallelJobs = mode === "deep-only" ? [] : jobs.splice(0, 2);
if (parallelJobs.length > 0) {
  failures.push(...await runParallelJobs(parallelJobs, run));
  console.log("✓ fast + quick 并行完成");
}
for (const [name, args, timeout] of jobs) {
  try {
    await run(name, args, timeout);
  } catch (error) {
    failures.push({ name, error });
  }
}

if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`${name} 失败：${error.message}`);
  process.exitCode = 1;
} else {
  console.log(`回归通过（${mode}），总耗时 ${((performance.now() - startedAt) / 1000).toFixed(2)} 秒`);
}
