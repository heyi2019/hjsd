import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../frontend");

function selected(paths: string): string {
  return execFileSync(process.execPath, ["scripts/test-changed.mjs", "--list"], {
    cwd: frontend,
    encoding: "utf8",
    env: { ...process.env, TEST_CHANGED_PATHS: paths },
  });
}

describe("前端变更选测", () => {
  it("资金收支变更同时覆盖使用它的业务和资金测试", () => {
    const output = selected("frontend/src/finance/cashflow/cashflow-modal.tsx");
    expect(output).toContain("tests/frontend/module/business");
    expect(output).toContain("tests/frontend/module/finance");
  });

  it("登录认证影响全站，按全量前端测试选取", () => {
    expect(selected("frontend/src/settings/auth/LoginPage.tsx")).toContain("npm run test:full:all");
  });

  it("用户设置变更覆盖设置和使用用户信息的业务测试", () => {
    const output = selected("frontend/src/settings/users/UsersPanel.tsx");
    expect(output).toContain("tests/frontend/module/settings");
    expect(output).toContain("tests/frontend/module/business");
    expect(output).toContain("tests/frontend/module/finance");
  });

  it.each([
    ["frontend/src/operations/DataCenterPanel.tsx", "tests/frontend/module/operations"],
    ["frontend/src/settings/field_definitions/OrderFormFieldsPanel.tsx", "tests/frontend/module/settings"],
  ])("%s 选择对应业务区域", (changed, expected) => {
    expect(selected(changed)).toContain(expected);
  });

  it.each([
    "frontend/src/shared/lib/money.ts",
    "frontend/src/unregistered/Example.tsx",
    "tests/fixtures/render.tsx",
  ])("%s 影响范围不确定时执行所有前端测试", (changed) => {
    expect(selected(changed)).toContain("npm run test:full:all");
  });
});
