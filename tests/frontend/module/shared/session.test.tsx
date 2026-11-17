import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import * as client from "@/shared/api/client";
import { ACCESS_TOKEN_KEY, DEV_USER_KEY } from "@/shared/api/client";
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, type Permission, useSession } from "@/shared/state/session";

vi.mock("@/shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/client")>()),
  login: vi.fn(),
  currentUser: vi.fn(),
}));

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  // mock 调用记录会跨用例累积；不清空则「不调用真实登录接口」这类断言会被前序用例污染。
  vi.clearAllMocks();
  vi.mocked(client.currentUser).mockRejectedValue(new Error("backend unavailable"));
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

/** 探针组件：把 session 暴露成可断言的文本，避免在测试里重复写 Context 样板。 */
function Probe() {
  const { role, username, permissions, can, switchUser, authenticated, mustChangePassword, login } = useSession();
  return (
    <div>
      <span data-testid="role">{role}</span>
      <span data-testid="username">{username}</span>
      <span data-testid="perm-count">{permissions.size}</span>
      <span data-testid="can-create">{String(can("order.create"))}</span>
      <span data-testid="can-update">{String(can("order.update"))}</span>
      <span data-testid="authenticated">{String(authenticated)}</span>
      <span data-testid="must-change-password">{String(mustChangePassword)}</span>
      <button type="button" onClick={() => switchUser("finance")}>
        切到财务
      </button>
      <button type="button" onClick={() => void login("admin", "")}>
        开发免密登录
      </button>
      <button type="button" onClick={() => void login("xiaoxuan", "pwd")}>
        真实登录
      </button>
    </div>
  );
}

beforeEach(() => {
  localStorage.removeItem(DEV_USER_KEY);
});

describe("SessionProvider：角色 → 权限", () => {
  it("admin 拥有全部权限点", () => {
    renderLight(<Probe />, { user: "admin" });
    expect(screen.getByTestId("perm-count").textContent).toBe(String(ALL_PERMISSIONS.length));
    expect(screen.getByTestId("can-create").textContent).toBe("true");
  });

  it("operator 能建单且能处理异常（operator 有 order.update）", () => {
    renderLight(<Probe />, { user: "operator" });
    expect(screen.getByTestId("can-create").textContent).toBe("true");
    expect(screen.getByTestId("can-update").textContent).toBe("true");
  });

  it("viewer 不能建单（只读角色）", () => {
    renderLight(<Probe />, { user: "viewer" });
    expect(screen.getByTestId("can-create").textContent).toBe("false");
  });

  it("finance 可读财务但不可改客户", () => {
    renderLight(<Probe />, { user: "finance" });
    const probe = screen.getByTestId("role");
    expect(probe.textContent).toBe("finance");
  });

  it("未知角色回落为空权限，不崩且 can 恒 false", () => {
    renderLight(<Probe />, { user: "nobody" });
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
    renderLight(<Probe />, { user: "admin" });
    expect(screen.getByTestId("can-create").textContent).toBe("true");
    await ui.click(screen.getByRole("button", { name: "切到财务" }));
    expect(screen.getByTestId("role").textContent).toBe("finance");
    expect(localStorage.getItem(DEV_USER_KEY)).toBe("finance");
    expect(screen.getByTestId("can-update").textContent).toBe("false");
  });
});

describe("开发版免密登录", () => {
  it("组件测试默认不请求后端同步开发用户", () => {
    renderLight(<Probe />, { user: "admin" });
    expect(client.currentUser).not.toHaveBeenCalled();
  });

  it("dev 启动忽略残留 token，不进入首次改密流程", async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, "stale-token");
    vi.mocked(client.currentUser).mockResolvedValue({ id: 1, username: "19873133890", role: "ADMIN", display_name: "何一", must_change_password: true });
    renderLight(<Probe />, { user: "admin", syncDevUser: true });

    await waitFor(() => expect(screen.getByTestId("authenticated")).toHaveTextContent("true"));
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(screen.getByTestId("must-change-password")).toHaveTextContent("false");
  });

  it("admin 留空密码时直接建立开发会话，不调用真实密码登录接口", async () => {
    renderLight(<Probe />);

    await ui.click(screen.getByRole("button", { name: "开发免密登录" }));

    expect(screen.getByTestId("role")).toHaveTextContent("admin");
    expect(screen.getByTestId("authenticated")).toHaveTextContent("true");
    expect(client.login).not.toHaveBeenCalled();
  });
});

describe("角色与用户分离", () => {
  it("开发态同步后端当前用户，负责人默认值按实际用户名匹配", async () => {
    vi.mocked(client.currentUser).mockResolvedValue({ id: 1, username: "19873133890", role: "ADMIN", display_name: "何一" });
    renderLight(<Probe />, { user: "admin", syncDevUser: true });

    await waitFor(() => expect(screen.getByTestId("username")).toHaveTextContent("19873133890"));
  });

  it("登录后 role 取 users.role、username 取 users.username，不互相代替", async () => {
    // 原实现把两者塞进同一个 user 字段：dev 态是用户名、生产态是角色，
    // 于是「按人匹配」的地方拿角色去比 username，生产必不命中。
    vi.mocked(client.login).mockResolvedValue({ id: 5, username: "xiaoxuan", role: "OPERATOR", display_name: "小轩" });
    renderLight(<Probe />, { user: "admin" });
    expect(screen.getByTestId("role")).toHaveTextContent("admin");

    await ui.click(screen.getByRole("button", { name: "真实登录" }));

    expect(screen.getByTestId("role")).toHaveTextContent("operator");
    expect(screen.getByTestId("username")).toHaveTextContent("xiaoxuan");
    // 权限仍按角色判定
    expect(screen.getByTestId("can-create")).toHaveTextContent("true");
  });
});

describe("useSession 边界", () => {
  it("脱离 Provider 使用会明确报错（而不是静默给空权限）", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const errorEvent = (event: ErrorEvent) => {
      if (event.error instanceof Error && /SessionProvider/.test(event.error.message)) event.preventDefault();
    };
    window.addEventListener("error", errorEvent);
    try {
      expect(() => render(<Probe />)).toThrow(/SessionProvider/);
    } finally {
      window.removeEventListener("error", errorEvent);
      consoleError.mockRestore();
    }
  });

  it("权限码类型收窄：不存在的权限调用不抛错，返回 false", () => {
    renderLight(<Probe />, { user: "admin" });
    const codes: Permission[] = ["order.create", "audit.read"];
    expect(codes.every((c) => ALL_PERMISSIONS.includes(c))).toBe(true);
  });
});
