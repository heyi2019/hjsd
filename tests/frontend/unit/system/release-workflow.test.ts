import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
function workflow(name: string): any {
  return parse(readFileSync(path.join(root, ".github/workflows", name), "utf8"));
}

describe("发布门禁与部署契约", () => {
  it("三个门禁验证同一发布提交，全部成功后才启动部署", () => {
    const release = workflow("main-ci-cd.yml");
    const jobs = release.jobs;
    const sha = "${{ needs.prepare-release.outputs.sha }}";
    for (const [job, file] of [["lint", "lint-gate.yml"], ["frontend", "frontend-gate.yml"], ["backend", "backend-gate.yml"]]) {
      expect(jobs[job]?.needs).toEqual(["prepare-release"]);
      expect(jobs[job]?.uses).toBe(`./.github/workflows/${file}`);
      expect(jobs[job]?.with?.release_sha).toBe(sha);
      expect(jobs[job]?.if).toBeUndefined();
    }
    const report = jobs["full-release-report"];
    expect(report.needs).toEqual(["prepare-release", "lint", "frontend", "backend"]);
    expect(report.if).toContain("always()");
    expect(report.if).toContain("needs.prepare-release.result == 'success'");
    const generate = report.steps.find((step: any) => step.name === "Generate full release report");
    const upload = report.steps.find((step: any) => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
    expect(generate.if).toContain("needs.prepare-release.outputs.full_suite == 'true'");
    expect(upload.if).toContain("needs.prepare-release.outputs.full_suite == 'true'");
    expect(upload.with.name).toContain("github.run_id");
    expect(upload.with.name).toContain("github.run_attempt");
    expect(upload.with.path).toContain("release-test-report.md");
    expect(upload.with["if-no-files-found"]).toBe("error");
    const temp = mkdtempSync(path.join(os.tmpdir(), "release-report-test-"));
    try {
      const summary = path.join(temp, "summary");
      writeFileSync(summary, "");
      const env = { ...process.env, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary,
        GITHUB_SERVER_URL: "https://github.example", GITHUB_REPOSITORY: "example/erp", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2",
        RELEASE_VERSION: "1.2.3", RELEASE_SHA: "a".repeat(40), LINT_RESULT: "success", FRONTEND_RESULT: "failure", BACKEND_RESULT: "cancelled" };
      const result = spawnSync("bash", ["-e", "-c", generate.run], { env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const text = readFileSync(path.join(temp, "release-test-report.md"), "utf8");
      for (const expected of ["1.2.3", "a".repeat(40), "success", "failure", "cancelled", "https://github.example/example/erp/actions/runs/123", "2"]) {
        expect(text).toContain(expected);
      }
      expect(readFileSync(summary, "utf8")).toContain("1.2.3");
      const skipped = spawnSync("bash", ["-e", "-c", generate.run], {
        env: { ...env, FRONTEND_RESULT: "skipped" }, encoding: "utf8",
      });
      expect(skipped.status, skipped.stderr).toBe(0);
      expect(readFileSync(path.join(temp, "release-test-report.md"), "utf8")).toContain("skipped");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    expect(jobs.deploy?.needs).toEqual(["prepare-release", "lint", "frontend", "backend", "full-release-report"]);
    expect(jobs.deploy.if).toBeUndefined();
    expect(jobs.deploy.uses).toBe("./.github/workflows/deploy-production.yml");
    expect(jobs.deploy.with.release_sha).toBe(sha);
    expect(jobs.deploy.with.wait_for_gates).toBe(true);
    expect(jobs.deploy.with.gates_verified).toBe(true);
    expect(jobs.deploy.secrets).toBe("inherit");
    expect(jobs["wait-and-deploy"]).toBeUndefined();
  });

  it("被调用的门禁检出发布提交，同时保留单独触发入口", () => {
    for (const [file, jobs] of [
      ["lint-gate.yml", ["lint"]],
      ["backend-gate.yml", ["backend-tests"]],
      ["frontend-gate.yml", ["frontend-tests", "frontend-build", "browser-e2e"]],
    ] as const) {
      const gate = workflow(file);
      expect(gate.on.workflow_call?.inputs?.release_sha?.type).toBe("string");
      expect(gate.on.workflow_dispatch).toBeDefined();
      for (const name of jobs) {
        const checkout = gate.jobs[name].steps.find((step: any) => String(step.uses ?? "").startsWith("actions/checkout@"));
        expect(checkout?.with?.ref).toBe("${{ inputs.release_sha || github.sha }}");
        const verify = gate.jobs[name].steps.find((step: any) => step.name === "Verify release commit");
        expect(verify?.env?.EXPECTED_RELEASE_SHA).toBe("${{ inputs.release_sha }}");
        expect(verify?.run).toContain("git rev-parse HEAD");
        if (name !== "browser-e2e") expect(gate.jobs[name].if).toBeUndefined();
      }
    }
  });

  it("数据库重建要求前后端全量，普通发布继续按变更选测", () => {
    const release = workflow("main-ci-cd.yml");
    const full = "${{ fromJSON(needs.prepare-release.outputs.full_suite) }}";
    for (const name of ["frontend", "backend"]) {
      expect(release.jobs[name]?.with?.full_suite).toBe(full);
      expect(release.jobs[name].with.changed_paths).toBe("${{ needs.prepare-release.outputs.changed_paths }}");
    }
    expect(release.jobs.deploy.with.reset_database).toBe("${{ fromJSON(needs.prepare-release.outputs.reset_database) }}");
    const browser = workflow("frontend-gate.yml").jobs["browser-e2e"];
    expect(browser.if).toContain("inputs.full_suite");
    expect(browser.if).toContain("inputs.release_sha");
    expect(browser.if).toContain("workflow_dispatch");
  });

  it("E2E 变更会传递给浏览器任务并选取对应规格", () => {
    const jobs = workflow("frontend-gate.yml").jobs;
    expect(jobs["browser-e2e"].needs).toContain("frontend-tests");
    expect(jobs["frontend-tests"].outputs.e2e_mode).toContain("steps.scope.outputs.e2e_mode");
    expect(jobs["browser-e2e"].if).toContain("needs.frontend-tests.outputs.e2e_mode");
    const step = jobs["browser-e2e"].steps.find((item: any) => item.name === "Run browser integration tests");
    expect(step.env.E2E_PATHS).toContain("needs.frontend-tests.outputs.e2e_paths");
    expect(step.run).toContain('"${specs[@]}"');
  });

  it("手动部署不能提供已过门禁标记，仍保留原有等待检查", () => {
    const deploy = workflow("deploy-production.yml");
    expect(deploy.on.workflow_call?.inputs?.gates_verified?.type).toBe("boolean");
    expect(deploy.on.workflow_dispatch.inputs.gates_verified).toBeUndefined();
    const wait = deploy.jobs.deploy.steps.find((step: any) => step.name === "Wait for required CI gates");
    expect(wait.if).toContain("inputs.wait_for_gates");
    expect(wait.if).toContain("!inputs.gates_verified");
    const verify = deploy.jobs.deploy.steps.find((step: any) => step.name === "Verify release commit");
    expect(verify?.env?.EXPECTED_RELEASE_SHA).toBe("${{ inputs.release_sha }}");
    expect(verify?.run).toContain("git rev-parse HEAD");
  });

  it("后端手动门禁保留按指定变更范围选测", () => {
    const gate = workflow("backend-gate.yml");
    expect(gate.on.workflow_dispatch.inputs.changed_paths.type).toBe("string");
    const checkout = gate.jobs["backend-tests"].steps.find((step: any) => String(step.uses ?? "").startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    const scope = gate.jobs["backend-tests"].steps.find((step: any) => step.id === "scope");
    expect(scope.run).toContain("scripts/ops/ci_test_scope.py");
  });

  it("日常推送和 PR 不自动运行云端门禁，正式发布仍会运行", () => {
    for (const file of ["lint-gate.yml", "frontend-gate.yml", "backend-gate.yml"]) {
      const triggers = workflow(file).on;
      expect(Object.keys(triggers).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
    }
    expect(workflow("main-ci-cd.yml").on.push.branches).toEqual(["main"]);
  });
});
