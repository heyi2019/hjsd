import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { LoginPage } from "@/auth/LoginPage";

import * as client from "@/shared/api/client";
vi.mock("@/shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/client")>()),
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  login: vi.fn(),
  logout: vi.fn(),
  setDevUser: vi.fn(),
  changePassword: vi.fn(),
  checkBackendHealth: vi.fn(),
}));

describe("LoginPage：后端前置检查", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("展示品牌介绍与清晰的账号密码登录入口", () => {
    vi.mocked(client.checkBackendHealth).mockResolvedValueOnce(undefined);
    renderLight(<LoginPage />);
    expect(screen.getByRole("heading", { name: /让经营更清晰/ })).toBeInTheDocument();
    expect(screen.getByLabelText("用户名")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("密码")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  });

  it("后端不可达时显示连接提示，而不是等待登录后才报 500", async () => {
    vi.mocked(client.checkBackendHealth).mockRejectedValueOnce(new Error("后端不可达"));

    renderLight(<LoginPage />, { user: "admin" });

    expect(await screen.findByRole("alert")).toHaveTextContent("后端不可达");
  });

  it("DEV 态 admin 留空密码可以直接登录", async () => {
    vi.mocked(client.checkBackendHealth).mockResolvedValueOnce(undefined);
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<LoginPage />);

    await ui.type(screen.getByLabelText("用户名"), "admin");
    await ui.click(screen.getByRole("button", { name: "登录" }));

    expect(client.login).not.toHaveBeenCalled();
    expect(screen.queryByText("请输入密码")).toBeNull();
  });
});
