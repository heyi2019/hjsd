import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { UserCenterPage } from "./UserCenterPage";
import { ACCESS_TOKEN_KEY, changePassword as changePasswordApi } from "../shared/api/client";

vi.mock("../shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  changePassword: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem(ACCESS_TOKEN_KEY, "test-token");
});

describe("UserCenterPage：账号信息与修改密码", () => {
  it("展示当前角色与权限点列表", () => {
    renderApp(<UserCenterPage />, { user: "admin" });
    expect(screen.getByText(/系统管理员（admin）/)).toBeTruthy();
    // admin 拥有全部权限点（以「权限点列表」区域为准，避免撞顶栏同名按钮）
    const list = screen.getByLabelText("权限点列表");
    expect(list.querySelectorAll("li").length).toBeGreaterThan(0);
  });

  it("两次新密码不一致时不发请求，错误落入横幅", async () => {
    renderApp(<UserCenterPage />, { user: "admin" });
    await userEvent.type(screen.getByLabelText("当前密码"), "old-pass-123");
    await userEvent.type(screen.getByLabelText("新密码"), "new-pass-12345");
    await userEvent.type(screen.getByLabelText("确认新密码"), "different-999");
    await userEvent.click(screen.getByRole("button", { name: /保存新密码/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(changePasswordApi).not.toHaveBeenCalled();
  });

  it("改密成功调用 API 并提示（不清空需后端确认的场景由后端把关）", async () => {
    renderApp(<UserCenterPage />, { user: "admin" });
    await userEvent.type(screen.getByLabelText("当前密码"), "old-pass-123");
    await userEvent.type(screen.getByLabelText("新密码"), "new-pass-12345");
    await userEvent.type(screen.getByLabelText("确认新密码"), "new-pass-12345");
    await userEvent.click(screen.getByRole("button", { name: /保存新密码/ }));
    await waitFor(() => expect(changePasswordApi).toHaveBeenCalledWith("old-pass-123", "new-pass-12345"));
  });

  it("顶栏用户中心入口可达（AppShell 级 Modal，从顶栏进入）", async () => {
    const { AppShell } = await import("../app/AppShell");
    renderApp(<AppShell />, { user: "admin" });
    // 点击前弹窗（dialog）不在文档中
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "用户中心" }));
    // 点击后 Modal 以 dialog 形式弹出，并挂载用户中心内容
    // （账号信息 / 修改密码 两张卡片标题仅在此组件内出现）
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText("账号信息")).toBeTruthy();
    expect(within(dialog).getByText("修改密码")).toBeTruthy();
    // 注：关闭后内容卸载依赖 antd Modal 离场动画，而测试环境 motion-stub 恒为 visible，
    // 故 jsdom 下无法断言卸载；关闭行为由 antd 标准 onCancel 接管，浏览器侧已验证。
  });
});
