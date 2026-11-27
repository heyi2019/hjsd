import { describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runParallelJobs } from "../../../../frontend/scripts/test-full-sharded-scheduling.mjs";
import { fastTests, quickTests } from "../../../../frontend/scripts/test-layers.mjs";

describe("全量回归层调度", () => {
  it("fast 与 quick 同时启动，并保留各层完成结果", async () => {
    const events: string[] = [];
    const run = async (name: string, _args: string[], _timeout: number, options: { buffered?: boolean }) => {
      events.push(`${name}:start:${options.buffered ? "buffered" : "direct"}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`${name}:end`);
    };

    const failures = await runParallelJobs(
      [
        ["fast", ["fast"], 60_000],
        ["quick", ["quick"], 150_000],
      ],
      run,
    );

    expect(events.slice(0, 2)).toEqual(["fast:start:buffered", "quick:start:buffered"]);
    expect(events.slice(2)).toEqual(["fast:end", "quick:end"]);
    expect(failures).toEqual([]);
  });

  describe.skipIf(process.platform === "win32")("进程组调度", () => {
    it.each(["test:fast", "test:react"])("%s 失败后跳过后续重型层", (failedJob) => {
      const root = mkdtempSync(join(tmpdir(), "heijin-test-scheduling-"));
      try {
        const scripts = join(root, "frontend/scripts");
        const bin = join(root, "bin");
        mkdirSync(scripts, { recursive: true });
        mkdirSync(bin);
        for (const file of ["test-full-sharded.mjs", "test-full-sharded-scheduling.mjs", "test-layers.mjs"]) {
          copyFileSync(fileURLToPath(new URL(`../../../../frontend/scripts/${file}`, import.meta.url)), join(scripts, file));
        }
        for (const file of [fastTests[0], quickTests[0]]) {
          mkdirSync(dirname(join(root, file)), { recursive: true });
          writeFileSync(join(root, file), "");
        }
        const npm = join(bin, "npm");
        writeFileSync(npm, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$JOB_LOG"\ncase "$*" in *"$FAILED_JOB"*) exit 1;; esac\n');
        chmodSync(npm, 0o755);
        const log = join(root, "jobs.log");
        const result = spawnSync(process.execPath, [join(scripts, "test-full-sharded.mjs"), "--all"], {
          cwd: join(root, "frontend"),
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, JOB_LOG: log, FAILED_JOB: failedJob },
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(result.status).toBe(1);
        const jobs = readFileSync(log, "utf8");
        expect(jobs).toContain("test:fast");
        expect(jobs).toContain("test:quick");
        if (failedJob === "test:fast") expect(jobs).not.toContain("test:react");
        else expect(jobs).toContain("test:react");
        expect(jobs).not.toContain("test:react-deep");
        expect(result.stderr).toContain("跳过");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it.each(["timeout", "signal"])("测试层 %s 后连同子进程结束", async (reason) => {
      const root = mkdtempSync(join(tmpdir(), "heijin-test-timeout-"));
      const pidFile = join(root, "worker.pid");
      let workerPid = 0;
      let controller: ChildProcess | undefined;
      const alive = (pid: number) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      };
      try {
        const scripts = join(root, "frontend/scripts");
        const bin = join(root, "bin");
        mkdirSync(scripts, { recursive: true });
        mkdirSync(bin);
        for (const file of ["test-full-sharded.mjs", "test-full-sharded-scheduling.mjs", "test-layers.mjs"]) {
          const source = fileURLToPath(new URL(`../../../../frontend/scripts/${file}`, import.meta.url));
          if (file === "test-full-sharded.mjs") {
            writeFileSync(join(scripts, file), readFileSync(source, "utf8").replace("quick: 150_000", "quick: 1_200"));
          } else copyFileSync(source, join(scripts, file));
        }
        for (const file of [fastTests[0], quickTests[0]]) {
          mkdirSync(dirname(join(root, file)), { recursive: true });
          writeFileSync(join(root, file), "");
        }
        const npm = join(bin, "npm");
        writeFileSync(npm, `#!/bin/sh
  case "$*" in *test:quick*)
    "$TEST_NODE" -e 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)' "$PID_FILE" >/dev/null 2>&1
    ;;
  esac
  `);
        chmodSync(npm, 0o755);
        let stderr = "";
        controller = spawn(process.execPath, [join(scripts, "test-full-sharded.mjs"), "--all"], {
          cwd: join(root, "frontend"),
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PID_FILE: pidFile, TEST_NODE: process.execPath },
          stdio: ["ignore", "ignore", "pipe"],
        });
        controller.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
        const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          controller!.on("close", (code, signal) => resolve({ code, signal }));
        });
        for (let retry = 0; retry < 100 && !existsSync(pidFile); retry++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        workerPid = Number(readFileSync(pidFile, "utf8"));
        if (reason === "signal") controller.kill("SIGTERM");
        const result = await done;
        expect(result.code, stderr).toBe(reason === "timeout" ? 1 : 143);
        for (let retry = 0; retry < 40 && alive(workerPid); retry++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(alive(workerPid)).toBe(false);
      } finally {
        if (controller && controller.exitCode === null && controller.signalCode === null) controller.kill("SIGKILL");
        if (workerPid && alive(workerPid)) process.kill(workerPid, "SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
    }, 10_000);
  });
});

describe("测试耗时诊断", () => {
  it.skipIf(process.platform === "win32")("仅对指定提交以来变更的前端测试计时", () => {
    const root = mkdtempSync(join(tmpdir(), "heijin-since-timing-"));
    try {
      const frontend = join(root, "frontend");
      const source = join(frontend, "src/index.ts");
      const changed = join(root, "tests/frontend/unit/system/example.test.ts");
      const bin = join(root, "bin");
      mkdirSync(dirname(source), { recursive: true });
      mkdirSync(dirname(changed), { recursive: true });
      mkdirSync(bin);
      writeFileSync(source, "original\n");
      writeFileSync(changed, "original\n");
      const git = (...args: string[]) => {
        const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
      };
      git("init", "-q");
      git("add", "frontend/src/index.ts", "tests/frontend/unit/system/example.test.ts");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
      writeFileSync(changed, "changed\n");
      const fake = join(root, "vitest.cjs");
      writeFileSync(fake, `
const fs = require('node:fs');
fs.writeFileSync(process.env.TIMING_ARGS, process.argv.join('\\n'));
const output = process.argv.find((arg) => arg.startsWith('--outputFile.json=')).split('=')[1];
fs.writeFileSync(output, JSON.stringify({ testResults: [{ name: 'sample.test.ts', startTime: 1000, endTime: 1001, assertionResults: [{ title: 'sample', duration: 1, status: 'passed' }] }] }));
`);
      const npx = join(bin, "npx");
      writeFileSync(npx, '#!/bin/sh\nexec "$TEST_NODE" "$FAKE_VITEST" "$@"\n');
      chmodSync(npx, 0o755);
      const log = join(root, "args");
      const script = fileURLToPath(new URL("../../../../frontend/scripts/test-timing.mjs", import.meta.url));
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, TEST_NODE: process.execPath,
        FAKE_VITEST: fake, TIMING_ARGS: log, TMPDIR: root };
      const run = (commit: string) => spawnSync(process.execPath, [script, "--project", "fast", "--since", commit],
        { cwd: frontend, env, encoding: "utf8", timeout: 10_000 });
      const selected = run("HEAD");
      expect(selected.status, selected.stderr).toBe(0);
      expect(readFileSync(log, "utf8")).toContain("tests/frontend/unit/system/example.test.ts");

      writeFileSync(changed, "original\n");
      writeFileSync(source, "changed\n");
      rmSync(log);
      const noTests = run("HEAD");
      expect(noTests.status, noTests.stderr).toBe(0);
      expect(noTests.stdout).toContain("没有更改的前端测试文件");
      expect(existsSync(log)).toBe(false);
      const invalid = run("not-a-commit");
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr).toContain("无法获取变更");
      expect(existsSync(log)).toBe(false);

      rmSync(changed);
      const deleted = run("HEAD");
      expect(deleted.status, deleted.stderr).toBe(0);
      expect(deleted.stdout).toContain("没有更改的前端测试文件");
      expect(existsSync(log)).toBe(false);
      const untracked = join(root, "tests/frontend/unit/system/new.test.ts");
      writeFileSync(untracked, "new\n");
      const added = run("HEAD");
      expect(added.status, added.stderr).toBe(0);
      expect(readFileSync(log, "utf8")).toContain("tests/frontend/unit/system/new.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("分析已有报告时保留原始报告和计时信息", () => {
    const root = mkdtempSync(join(tmpdir(), "heijin-existing-timing-"));
    try {
      const script = fileURLToPath(new URL("../../../../frontend/scripts/test-timing.mjs", import.meta.url));
      const report = JSON.stringify({ testResults: [{ name: "sample.test.ts", startTime: 1000, endTime: 1010,
        assertionResults: [{ title: "sample", duration: 10, status: "passed" }] }] });
      const withoutExtension = join(root, "report");
      writeFileSync(withoutExtension, report);
      const first = spawnSync(process.execPath, [script, "--from", withoutExtension], { encoding: "utf8" });
      expect(first.status, first.stderr).toBe(0);
      expect(readFileSync(withoutExtension, "utf8")).toBe(report);
      expect(existsSync(`${withoutExtension}.summary.json`)).toBe(false);

      const withExtension = join(root, "report.json");
      const summary = join(root, "report.summary.json");
      const originalSummary = JSON.stringify({ project: "quick", wallSeconds: 42, cpuSeconds: 12 });
      writeFileSync(withExtension, report);
      writeFileSync(summary, originalSummary);
      const second = spawnSync(process.execPath, [script, "--from", withExtension], { encoding: "utf8" });
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain("project=quick");
      expect(second.stdout).toContain("wall=42.0");
      expect(second.stdout).toContain("cpu=12.0");
      expect(readFileSync(summary, "utf8")).toBe(originalSummary);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")("测试成功时不把系统资源统计错误当作测试失败", () => {
    const root = mkdtempSync(join(tmpdir(), "heijin-test-timing-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const fake = join(root, "vitest.cjs");
      writeFileSync(fake, `
const fs = require('node:fs');
const output = process.argv.find((arg) => arg.startsWith('--outputFile.json=')).split('=')[1];
fs.writeFileSync(output, JSON.stringify({ testResults: [{ name: 'sample.test.ts', startTime: 1000, endTime: 1001, assertionResults: [{ title: 'sample', duration: 1, status: 'passed' }] }] }));
`);
      const npx = join(bin, "npx");
      writeFileSync(npx, '#!/bin/sh\nexec "$TEST_NODE" "$FAKE_VITEST" "$@"\n');
      chmodSync(npx, 0o755);
      const script = fileURLToPath(new URL("../../../../frontend/scripts/test-timing.mjs", import.meta.url));
      const result = spawnSync(process.execPath, [script, "--project", "fast"], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, TEST_NODE: process.execPath, FAKE_VITEST: fake, TMPDIR: root },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("TIMING_TOTAL files=1 tests=1");
      expect(result.stderr).not.toContain("vitest 退出码");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
