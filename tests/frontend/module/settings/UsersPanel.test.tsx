import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { UsersPanel } from "@/users/UsersPanel";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

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

const user = {
  id: 7,
  username: "operator01",
  display_name: "业务同事",
  role: "OPERATOR",
  owner_scope: "SELF",
  team_ids: [],
  is_active: true,
  must_change_password: false,
};

beforeEach(() => {
  vi.mocked(client.api).get.mockResolvedValue({ data: [user] });
  vi.mocked(client.api).post.mockResolvedValue({ data: {} });
  vi.mocked(client.api).patch.mockResolvedValue({ data: user });
});

describe("UsersPanel：用户管理动作", () => {
  it("开发态角色不在服务端人员列表时给出明确说明", async () => {
    renderLight(<UsersPanel />, { user: "admin" });

    expect(await screen.findByText("operator01")).toBeInTheDocument();
    expect(screen.getByText(/开发态当前角色：admin/)).toBeInTheDocument();
    expect(screen.getByText(/开发态角色不纳入服务端人员列表/)).toBeInTheDocument();
  });

  it("管理员可以编辑用户并提交更新", async () => {
    renderLight(<UsersPanel />, { user: "admin" });

    expect(await screen.findByText("operator01")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /编辑/ }));
    const dialog = within(screen.getByRole("dialog", { name: "编辑用户：operator01" }));
    const name = dialog.getByDisplayValue("业务同事");
    await ui.clear(name);
    await ui.type(name, "新业务同事");
    await ui.click(dialog.getByRole("button", { name: /OK/ }));

    await waitFor(() => expect(vi.mocked(client.api).patch).toHaveBeenCalledWith("/users/7", expect.objectContaining({ display_name: "新业务同事" })));
  });

  // 手机号是免密登录（手机号验证码 / 微信扫码）的准入依据，2026-11-05 补进用户编辑：
  // 后端 UserUpdate 一直支持 phone，但界面上没有入口，管理员无法自助配置。
  it("用户编辑可填写手机号并随更新提交，空值不报错", async () => {
    renderLight(<UsersPanel />, { user: "admin" });

    expect(await screen.findByText("operator01")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /编辑/ }));
    const dialog = within(screen.getByRole("dialog", { name: "编辑用户：operator01" }));

    // 字段存在且带说明
    expect(dialog.getByText("手机号")).toBeInTheDocument();
    expect(dialog.getByText("留空表示不启用免密登录")).toBeInTheDocument();

    await ui.type(dialog.getByLabelText("手机号"), "13900002222");
    await ui.click(dialog.getByRole("button", { name: /OK/ }));

    await waitFor(() =>
      expect(vi.mocked(client.api).patch).toHaveBeenCalledWith(
        "/users/7",
        expect.objectContaining({ phone: "13900002222" }),
      ),
    );
  });

  it("手机号格式不对时前端即时拦截，不发请求", async () => {
    renderLight(<UsersPanel />, { user: "admin" });

    expect(await screen.findByText("operator01")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /编辑/ }));
    const dialog = within(screen.getByRole("dialog", { name: "编辑用户：operator01" }));

    await ui.type(dialog.getByLabelText("手机号"), "1390000");
    await ui.click(dialog.getByRole("button", { name: /OK/ }));

    expect(await dialog.findByText("请输入正确的 11 位手机号")).toBeInTheDocument();
    expect(vi.mocked(client.api).patch).not.toHaveBeenCalled();
  });

  // 停用与重置密码拆成两个用例：停用现在带 Popconfirm，弹层残留会干扰后续点击。
  it("管理员停用用户需二次确认", async () => {
    renderLight(<UsersPanel />, { user: "admin" });

    expect(await screen.findByText("operator01")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /停用/ }));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    await waitFor(() => expect(vi.mocked(client.api).patch).toHaveBeenCalledWith("/users/7", { is_active: false }));
  });

  it("管理员可以重置密码", async () => {
    renderLight(<UsersPanel />, { user: "admin" });

    expect(await screen.findByText("operator01")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /重置密码/ }));
    const resetDialog = within(await screen.findByRole("dialog", { name: "重置密码：operator01" }));
    await ui.type(resetDialog.getByPlaceholderText("新密码（至少 8 位）"), "new-password");
    await ui.click(resetDialog.getByRole("button", { name: /OK/ }));
    await waitFor(() => expect(vi.mocked(client.api).post).toHaveBeenCalledWith("/users/7/reset-password", { password: "new-password" }));
  });

  it("接口异常时禁用新增用户并展示错误重试态", async () => {
    vi.mocked(client.api).get.mockRejectedValue(new Error("拉取失败"));
    renderLight(<UsersPanel />, { user: "admin" });
    const addBtn = await screen.findByRole("button", { name: /新增用户/ });
    await waitFor(() => expect(addBtn).toBeDisabled());
    expect(screen.getByText(/拉取失败/)).toBeInTheDocument();
  });

  it("新增用户空提交被必填校验拦截并显示字段级错误（L1743）", async () => {
    renderLight(<UsersPanel />, { user: "admin" });
    await screen.findByText("operator01");
    await ui.click(screen.getByRole("button", { name: /新增用户/ }));
    // 必填校验拦截：出现字段级错误标记，且不发创建请求
    await waitFor(() => expect(document.querySelector(".ant-form-item-explain-error")).toBeTruthy());
    expect(vi.mocked(client.api).post).not.toHaveBeenCalledWith("/users", expect.any(Object));
  });
});
