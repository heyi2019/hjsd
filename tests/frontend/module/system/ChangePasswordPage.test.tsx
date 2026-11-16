import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { ChangePasswordPage } from "@/auth/ChangePasswordPage";

const changePassword = vi.fn();
const logout = vi.fn();
vi.mock("@/shared/state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/state/session")>();
  return {
    ...actual,
    useSession: () => ({ changePassword, logout }),
  };
});

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  changePassword.mockResolvedValue(undefined);
  logout.mockResolvedValue(undefined);
});

describe("ChangePasswordPage：首次登录改密", () => {
  it("首次登录改密复用登录页的品牌布局", () => {
    renderLight(<ChangePasswordPage />);
    expect(screen.getByRole("region", { name: "产品介绍" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "首次登录设置密码" })).toBeInTheDocument();
  });

  it("两次新密码不一致给出错误提示", async () => {
    renderLight(<ChangePasswordPage />);
    await ui.type(screen.getByLabelText("当前密码"), "old");
    await ui.type(screen.getByLabelText("新密码"), "newpassword");
    await ui.type(screen.getByLabelText("确认新密码"), "different");
    await ui.click(screen.getByRole("button", { name: /保存新密码/ }));
    expect(await screen.findByText("两次输入的新密码不一致")).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("提交成功调用 changePassword", async () => {
    renderLight(<ChangePasswordPage />);
    await ui.type(screen.getByLabelText("当前密码"), "old");
    await ui.type(screen.getByLabelText("新密码"), "newpassword");
    await ui.type(screen.getByLabelText("确认新密码"), "newpassword");
    await ui.click(screen.getByRole("button", { name: /保存新密码/ }));
    await waitFor(() => expect(changePassword).toHaveBeenCalledWith("old", "newpassword"));
  });

  it("提交失败展示后端错误", async () => {
    changePassword.mockRejectedValue(new Error("原密码错误"));
    renderLight(<ChangePasswordPage />);
    await ui.type(screen.getByLabelText("当前密码"), "old");
    await ui.type(screen.getByLabelText("新密码"), "newpassword");
    await ui.type(screen.getByLabelText("确认新密码"), "newpassword");
    await ui.click(screen.getByRole("button", { name: /保存新密码/ }));
    expect(await screen.findByText(/原密码错误/)).toBeInTheDocument();
  });

  it("退出登录调用 logout", async () => {
    renderLight(<ChangePasswordPage />);
    await ui.click(screen.getByRole("button", { name: /退出登录/ }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
  });
});
