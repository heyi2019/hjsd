import { fireEvent, screen, waitFor } from "@testing-library/react";
import { appMessage as message } from "../shared/ui/appFeedback";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { UserCenterPage } from "./UserCenterPage";
import { ACCESS_TOKEN_KEY, changePassword as changePasswordApi } from "../shared/api/client";
import * as client from "../shared/api/client";

vi.mock("../shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/api/client")>()),
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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem(ACCESS_TOKEN_KEY, "test-token");
});

afterEach(async () => {
  await act(async () => {
    message.destroy();
    await Promise.resolve();
  });
});

describe("UserCenterPage：账号信息与修改密码", () => {
  it("展示当前角色与权限点列表", () => {
    renderLight(<UserCenterPage />, { user: "admin" });
    expect(screen.getByText(/系统管理员（admin）/)).toBeTruthy();
    // admin 拥有全部权限点（以「权限点列表」区域为准，避免撞顶栏同名按钮）
    const list = screen.getByLabelText("权限点列表");
    expect(list.querySelectorAll("li").length).toBeGreaterThan(0);
  });

  it("两次新密码不一致时不发请求，错误落入横幅", async () => {
    renderLight(<UserCenterPage />, { user: "admin" });
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "old-pass-123" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new-pass-12345" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "different-999" } });
    fireEvent.click(screen.getByRole("button", { name: /保存新密码/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(changePasswordApi).not.toHaveBeenCalled();
  });

  it("改密成功调用 API 并提示（不清空需后端确认的场景由后端把关）", async () => {
    renderLight(<UserCenterPage />, { user: "admin" });
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "old-pass-123" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new-pass-12345" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "new-pass-12345" } });
    fireEvent.click(screen.getByRole("button", { name: /保存新密码/ }));
    await waitFor(() => expect(changePasswordApi).toHaveBeenCalledWith("old-pass-123", "new-pass-12345"));
    expect(await screen.findByText("密码已更新")).toBeInTheDocument();
  });
});
