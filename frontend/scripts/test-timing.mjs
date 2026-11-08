#!/usr/bin/env node
/**
 * 前端测试耗时实测工具（每个文件 / 每个用例多少秒）。
 *
 * 与旧版 test-timing.mjs 的区别：
 * 旧版为每个文件单独 spawn 一次 vitest，测到的是「冷启动 + Vite 引导 + transform」，
 * 与真实套内耗时不是同一个口径，且文件清单硬编码（早已漂移）。
 * 本版只跑一次目标 project，用 vitest 的 json reporter 取每个文件 / 每个用例的
 * 真实 duration，再补齐墙钟时间与并行度。
 *
 * 用法：
 *   node scripts/test-timing.mjs                    # 跑 react 层并出报告
 *   node scripts/test-timing.mjs --project quick
 *   node scripts/test-timing.mjs --top 50           # 最慢用例取前 50（默认 30）
 *   node scripts/test-timing.mjs --from /tmp/x.json # 不重跑，直接分析已有 json 报告
 *   node scripts/test-timing.mjs --since <commit>   # 只跑上次提交以来改动的文件
 *   node scripts/test-timing.mjs -- --maxWorkers=1 src/x.test.tsx   # A/B 对比固定串行
 *
 * 负载口径：机器上常有别的会话在抢 CPU（实测 load 5/8 核时同一份代码墙钟差 20%+），
 * 所以墙钟只在「本次 instrument 内」有意义。跨天/跨会话对比一律看 cpu= 那一项：
 * CPU 秒数（user+sys，含全部 worker 子进程）几乎不受外部负载影响，是 A/B 的唯一可靠依据。
 *
 * 输出末行为机器可读总览（便于 CI / 人工对比）：
 *   TIMING_TOTAL files=<n> tests=<n> wall=<s> sum=<s> cpu=<s> parallelism=<x> cpu_ratio=<x>
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, cpus, loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const hasFlag = (name) => argv.includes(name);

const project = argOf("--project", "react");
const topN = Number(argOf("--top", "30"));
const fromFile = argOf("--from", null);
const since = argOf("--since", null);
// "--" 之后的参数原样透传给 vitest（如 --maxWorkers=6 / --no-isolate / <file>）
const passthrough = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];
const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(FRONTEND, "..");
const BIN_NAME = process.platform === "win32" ? "vitest.cmd" : "vitest";
const vitest = [
  resolve(REPO, "node_modules", ".bin", BIN_NAME),
  resolve(FRONTEND, "node_modules", ".bin", BIN_NAME),
].find((candidate) => existsSync(candidate));

if (!vitest) {
  console.error("找不到 vitest 可执行文件：先在仓库根执行 npm ci");
  process.exit(2);
}

const reportPath = fromFile ?? join(tmpdir(), `vitest-timing-${project}-${Date.now()}.json`);

// ---- 0. CPU 口径：用 /usr/bin/time 取 user+sys（rusage 会把 worker 子进程一并折进来），
//         这是唯一不受其它会话抢 CPU 影响的对比量。取不到就退化为只有墙钟。
const TIME_BIN = "/usr/bin/time";
const canMeasureCpu = existsSync(TIME_BIN);
const timeFlag = process.platform === "darwin" ? "-l" : "-v";

// ---- 1. 取数据：已有报告直接解析，否则跑一次目标 project ----
let wallSeconds = null;
let cpuSeconds = null;
let phaseLine = "";
if (!fromFile) {
  const vitestArgs = [
    "run", `--project=${project}`,
    "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`,
  ];
  const changed = since ? changedFiles(since) : null;
  if (changed) vitestArgs.push(...changed);
  vitestArgs.push(...passthrough);
  process.stderr.write(`[timing] 运行 ${project} 层${changed ? `（${changed.length} 个改动文件）` : ""}…\n`);
  if (process.env.TIMING_DEBUG) process.stderr.write(`[timing] vitest ${vitestArgs.join(" ")}\n`);
  const cmd = canMeasureCpu ? TIME_BIN : vitest;
  const cmdArgs = canMeasureCpu ? [timeFlag, vitest, ...vitestArgs] : vitestArgs;
  const started = performance.now();
  // stderr 不直出：/usr/bin/time -l 会打上百行 rusage，只在失败时摘尾部。
  const child = spawn(cmd, cmdArgs, { cwd: FRONTEND, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { err += chunk.toString("utf8"); });
  const code = await new Promise((resolve) => child.on("close", resolve));
  wallSeconds = (performance.now() - started) / 1000;
  const line = out.split("\n").reverse().find((l) => l.includes("Duration") && l.includes("%"));
  phaseLine = line ? line.trim() : "";
  cpuSeconds = parseCpuSeconds(err);
  if (code !== 0) {
    process.stderr.write(`[timing] 注意：vitest 退出码 ${code}（有失败用例，耗时数据仍有效）\n`);
    const tail = err.trim().split("\n").slice(-60).join("\n");
    if (tail) process.stderr.write(`${tail}\n`);
  }
}

function parseCpuSeconds(text) {
  if (!canMeasureCpu) return null;
  if (process.platform === "darwin") {
    // "        0.12 real         0.50 user         0.10 sys"
    const m = text.match(/^\s*([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys\s*$/m);
    return m ? Number(m[2]) + Number(m[3]) : null;
  }
  const u = text.match(/User time \(seconds\):\s*([\d.]+)/);
  const s = text.match(/System time \(seconds\):\s*([\d.]+)/);
  return u && s ? Number(u[1]) + Number(s[1]) : null;
}

if (fromFile) {
  const side = fromFile.replace(/\.json$/, ".summary.json");
  if (existsSync(side)) {
    try { cpuSeconds = JSON.parse(readFileSync(side, "utf8")).cpuSeconds ?? null; } catch { /* 忽略 */ }
  }
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));

// ---- 2. 归一化：文件行 + 用例行 ----
const rows = [];
const tests = [];
for (const file of report.testResults ?? []) {
  let name = file.name ?? "";
  const idx = name.indexOf("frontend/");
  if (idx >= 0) name = name.slice(idx + "frontend/".length);
  const assertions = file.assertionResults ?? [];
  const testsMs = assertions.reduce((sum, a) => sum + (a.duration ?? 0), 0);
  const start = file.startTime;
  const end = file.endTime;
  const fileMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : testsMs;
  rows.push({
    file: name,
    fileMs,
    testsMs,
    count: assertions.length,
    failed: assertions.filter((a) => a.status === "failed").length,
  });
  for (const a of assertions) {
    tests.push({ file: name, title: a.title ?? "", ms: a.duration ?? 0, status: a.status ?? "" });
  }
}

const sumMs = rows.reduce((s, r) => s + r.fileMs, 0);
const testCount = tests.length;
const failedFiles = rows.filter((r) => r.failed > 0);
const sec = (ms) => `${(ms / 1000).toFixed(2)}s`.padStart(8);

// ---- 3. 报告 ----
console.log("\n" + "=".repeat(104));
console.log(`project=${project}  文件 ${rows.length}  用例 ${testCount}  失败文件 ${failedFiles.length}`);
console.log(`套内文件耗时合计 ${(sumMs / 1000).toFixed(1)}s` +
  (wallSeconds ? ` | 墙钟 ${wallSeconds.toFixed(1)}s | 并行度 ${(sumMs / 1000 / wallSeconds).toFixed(2)}x` : ""));
if (cpuSeconds) {
  const ratio = sumMs / 1000 / cpuSeconds;
  console.log(`CPU ${cpuSeconds.toFixed(1)}s（user+sys，含全部 worker 子进程）` +
    ` | 套内/CPU ${ratio.toFixed(2)}x${ratio > 1.05 ? "  ← 有真实并行空转" : ""}`);
}
if (phaseLine) console.log(`阶段占比：${phaseLine}`);
// 机器负载会直接污染墙钟：load 接近核数时，并行度与总时长都不可比。
// 实测教训：同一份代码两次全层跑出 101.5s 与 123.9s，差别只来自外部负载（load 14.7 / 8 核）。
const cores = cpus().length;
const load = loadavg()[0];
const loadTag = load > cores * 0.6
  ? "⚠ 负载偏高：墙钟不可对比，A/B 请看 cpu="
  : "负载正常";
console.log(`机器负载 ${load.toFixed(1)} / ${cores} 核 → ${loadTag}`);
console.log("=".repeat(104));

console.log("\n########## 每文件耗时（降序） ##########");
console.log("   文件耗时    用例均时  用例数  文件");
for (const r of [...rows].sort((a, b) => b.fileMs - a.fileMs)) {
  const avg = r.count ? r.fileMs / r.count : 0;
  console.log(`${sec(r.fileMs)} ${sec(avg)} ${String(r.count).padStart(7)}  ${r.file}${r.failed ? "  [FAIL]" : ""}`);
}

console.log(`\n########## 最慢 ${topN} 个用例 ##########`);
for (const t of [...tests].sort((a, b) => b.ms - a.ms).slice(0, topN)) {
  console.log(`${sec(t.ms)}  ${t.file}  ::  ${t.title.slice(0, 68)}`);
}

const coveredByTop = new Map();
for (const t of [...tests].sort((a, b) => b.ms - a.ms).slice(0, topN)) {
  coveredByTop.set(t.file, (coveredByTop.get(t.file) ?? 0) + t.ms);
}
console.log(`\nTop ${topN} 用例合计 ${( [...coveredByTop.values()].reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s` +
  `（占套内 ${(([...coveredByTop.values()].reduce((a, b) => a + b, 0) / sumMs) * 100).toFixed(0)}%）`);

const zero = tests.filter((t) => t.ms === 0).length;
console.log(`\n零耗时用例 ${zero} 个（多为同步纯逻辑断言，无需优化）`);

if (fromFile) console.log(`\n数据来源：${fromFile}`);
else console.log(`\n报告已写入：${reportPath}`);

console.log(`TIMING_TOTAL files=${rows.length} tests=${testCount} wall=${wallSeconds ? wallSeconds.toFixed(1) : "n/a"} ` +
  `sum=${(sumMs / 1000).toFixed(1)} cpu=${cpuSeconds ? cpuSeconds.toFixed(1) : "n/a"} ` +
  `parallelism=${wallSeconds ? (sumMs / 1000 / wallSeconds).toFixed(2) : "n/a"} ` +
  `cpu_ratio=${cpuSeconds ? (sumMs / 1000 / cpuSeconds).toFixed(2) : "n/a"}`);

writeFileSync(
  reportPath.replace(/\.json$/, ".summary.json"),
  JSON.stringify({ project, wallSeconds, cpuSeconds, sumSeconds: sumMs / 1000, rows, generatedAt: new Date().toISOString() }, null, 2),
);

function changedFiles(commit) {
  if (!existsSync(join(process.cwd(), "src"))) return null;
  const r = spawnSync("git", ["diff", "--name-only", commit, "--", "src"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const files = r.stdout.split("\n").map((s) => s.trim())
    .filter((f) => /\.(test|spec)\.(ts|tsx)$/.test(f));
  return files.length ? files : null;
}
