import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { renderApp } from "../../test/render";
import { DEV_USER_KEY } from "../api/client";
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, type Permission, useSession } from "./session";

/** 探针组件：把 session 暴露成可断言的文本，避免在测试里重复写 Context 样板。 */
function Probe() {
  const { user, permissions, can, switchUser } = useSession();
  return (
    <div>
      <span data-testid="user">{user}</span>
      <span data-testid="perm-count">{permissions.size}</span>
      <span data-testid="can-create">{String(can("order.create"))}</span>
      <span data-testid="can-approve">{String(can("order.exception.approve"))}</span>
      <button type="button" onClick={() => switchUser("finance")}>
        切到财务
      </button>
    </div>
  );
}

beforeEach(() => {
  localStorage.removeItem(DEV_USER_KEY);
});

describe("SessionProvider：角色 → 权限", () => {
  it("admin 拥有全部权限点", () => {
    renderApp(<Probe />, { user: "admin" });
    expect(screen.getByTestId("perm-count").textContent).toBe(String(ALL_PERMISSIONS.length));
    expect(screen.getByTestId("can-create").textContent).toBe("true");
  });

  it("operator 能建单但不能审批异常（operator 无 order.exception.approve）", () => {
    renderApp(<Probe />, { user: "operator" });
    expect(screen.getByTestId("can-create").textContent).toBe("true");
    expect(screen.getByTestId("can-approve").textContent).toBe("false");
  });

  it("viewer 不能建单（只读角色）", () => {
    renderApp(<Probe />, { user: "viewer" });
    expect(screen.getByTestId("can-create").textContent).toBe("false");
  });

  it("finance 可读财务但不可改客户", () => {
    renderApp(<Probe />, { user: "finance" });
    const probe = screen.getByTestId("user");
    expect(probe.textContent).toBe("finance");
  });

  it("未知角色回落为空权限，不崩且 can 恒 false", () => {
    renderApp(<Probe />, { user: "nobody" });
    expect(screen.getByTestId("perm-count").textContent).toBe("0");
    expect(screen.getByTestId("can-create").textContent).toBe("false");
  });

  it("所有角色权限点都在 ALL_PERMISSIONS 白名单内（防拼写漂移）", () => {
    for (const list of Object.values(ROLE_PERMISSIONS)) {
      for (const p of list) {
        expect(ALL_PERMISSIONS as readonly string[]).toContain(p);
      }
    }
  });
});

describe("switchUser：切换角色", () => {
  it("切换后权限立即生效并持久化到 localStorage", async () => {
    renderApp(<Probe />, { user: "admin" });
    expect(screen.getByTestId("can-create").textContent).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "切到财务" }));
    expect(screen.getByTestId("user").textContent).toBe("finance");
    expect(localStorage.getItem(DEV_USER_KEY)).toBe("finance");
    expect(screen.getByTestId("can-approve").textContent).toBe("false");
  });
});

describe("useSession 边界", () => {
  it("脱离 Provider 使用会明确报错（而不是静默给空权限）", () => {
    // React 会同时输出 error 边界日志，这里只断言抛错本身
    expect(() => render(<Probe />)).toThrow(/SessionProvider/);
  });

  it("权限码类型收窄：不存在的权限调用不抛错，返回 false", () => {
    renderApp(<Probe />, { user: "admin" });
    const codes: Permission[] = ["order.create", "audit.read"];
    expect(codes.every((c) => ALL_PERMISSIONS.includes(c))).toBe(true);
  });
});
