import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../frontend");
const execFileAsync = promisify(execFile);

async function selected(paths: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ["scripts/test-changed.mjs", "--list", ...args], {
    cwd: frontend,
    encoding: "utf8",
    env: { ...process.env, TEST_CHANGED_PATHS: paths },
  });
  return stdout;
}

describe.concurrent("前端变更选测", () => {
  it.each(["package.json", "package-lock.json", "patches/rc-field-form+2.7.1.patch"])(
    "%s 影响工作区依赖，选择完整前端回归",
    async (changed) => {
      expect(await selected(changed)).toContain("npm run test:full:all");
      expect(await selected(changed, "--ci")).toContain("npm run test:full:all");
    },
  );

  it("只有后端变更时，前端门禁选择 quick 测试", async () => {
    expect(await selected("backend/app/main.py", "--ci")).toContain("npm run test:quick");
  });

  it("仅修改测试文件时，只运行这些文件，包括 CI 选测", async () => {
    const reports = "tests/frontend/module/operations/reports/ReportsPage.deep.test.tsx";
    const workbench = "tests/frontend/module/workbench/WorkbenchPage.deep.test.tsx";
    for (const args of [[], ["--ci"]]) {
      const output = await selected(`${reports},${workbench}`, ...args);
      expect(output).toContain(reports);
      expect(output).toContain(workbench);
      expect(output).not.toMatch(/tests\/frontend\/(?:unit|module)\/(?:operations|workbench)(?:\s|$)/m);
      expect(output).not.toContain("npm run test:quick");
    }
  });

  it("源码按区域选测时，其他区域的测试变更只增加对应文件", async () => {
    const workbench = "tests/frontend/module/workbench/WorkbenchPage.deep.test.tsx";
    const output = await selected(`frontend/src/operations/DataCenterPanel.tsx,${workbench}`);
    expect(output).toContain("tests/frontend/module/operations");
    expect(output).toContain(workbench);
    expect(output).not.toMatch(/tests\/frontend\/(?:unit|module)\/workbench(?:\s|$)/m);
  });

  it("被删除的测试文件仍选其所属区域", async () => {
    expect(await selected("tests/frontend/module/finance/removed.test.tsx"))
      .toContain("tests/frontend/module/finance");
  });

  it("资金收支变更同时覆盖使用它的业务和资金测试", async () => {
    const output = await selected("frontend/src/finance/cashflow/cashflow-modal.tsx");
    expect(output).toContain("tests/frontend/module/business");
    expect(output).toContain("tests/frontend/module/finance");
  });

  it("登录认证影响全站，按全量前端测试选取", async () => {
    expect(await selected("frontend/src/settings/auth/LoginPage.tsx")).toContain("npm run test:full:all");
  });

  it("用户设置变更覆盖设置和使用用户信息的业务测试", async () => {
    const output = await selected("frontend/src/settings/users/UsersPanel.tsx");
    expect(output).toContain("tests/frontend/module/settings");
    expect(output).toContain("tests/frontend/module/business");
    expect(output).toContain("tests/frontend/module/finance");
  });

  it.each([
    ["frontend/src/operations/DataCenterPanel.tsx", "tests/frontend/module/operations"],
    ["frontend/src/settings/field_definitions/OrderFormFieldsPanel.tsx", "tests/frontend/module/settings"],
  ])("%s 选择对应业务区域", async (changed, expected) => {
    expect(await selected(changed)).toContain(expected);
  });

  it.each([
    "frontend/src/shared/lib/money.ts",
    "frontend/src/unregistered/Example.tsx",
    "tests/fixtures/render.tsx",
  ])("%s 影响范围不确定时执行所有前端测试", async (changed) => {
    expect(await selected(changed)).toContain("npm run test:full:all");
  });
});
