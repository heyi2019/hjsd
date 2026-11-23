import { readFileSync } from "node:fs";
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
    expect(jobs.deploy?.needs).toEqual(["prepare-release", "lint", "frontend", "backend"]);
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
        if (name !== "browser-e2e") expect(gate.jobs[name].if).toContain("inputs.release_sha");
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

  it("开发分支后端门禁按真实提交范围选测", () => {
    const gate = workflow("backend-gate.yml");
    expect(gate.on.push.branches).toContain("dev");
    const checkout = gate.jobs["backend-tests"].steps.find((step: any) => String(step.uses ?? "").startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    const scope = gate.jobs["backend-tests"].steps.find((step: any) => step.id === "scope");
    expect(scope.run).toContain("scripts/ops/ci_test_scope.py");
  });
});
