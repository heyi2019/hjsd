import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { ChangePasswordPage } from "@/auth/ChangePasswordPage";

const changePassword = vi.fn();
const logout = vi.fn();
// 免密登录的会话不收集「当前密码」，由后端按 token 的 amr 判定是否允许省略。
let passwordlessSession = false;
vi.mock("@/shared/state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/state/session")>();
  return {
    ...actual,
    useSession: () => ({ changePassword, logout, passwordlessSession }),
  };
});

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  passwordlessSession = false;
  changePassword.mockResolvedValue(undefined);
  logout.mockResolvedValue(undefined);
});

describe("ChangePasswordPage：首次登录改密", () => {
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

  it("免密登录的会话不要求当前密码", async () => {
    passwordlessSession = true;
    renderLight(<ChangePasswordPage />);
    // 用户从未输入过密码，这一栏不该出现——否则首次登录永远过不去。
    expect(screen.queryByLabelText("当前密码")).toBeNull();
    expect(screen.getByText(/免密方式登录/)).toBeInTheDocument();

    await ui.type(screen.getByLabelText("新密码"), "newpassword");
    await ui.type(screen.getByLabelText("确认新密码"), "newpassword");
    await ui.click(screen.getByRole("button", { name: /保存新密码/ }));
    await waitFor(() => expect(changePassword).toHaveBeenCalledWith(null, "newpassword"));
  });
});
