import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { message } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { UsersPanel } from "./UsersPanel";
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

const users = [
  { id: 7, username: "operator01", display_name: "业务同事", role: "OPERATOR", owner_scope: "SELF", team_ids: [], pool_ids: [], is_active: true, must_change_password: false },
  { id: 8, username: "viewer01", display_name: "查看人甲", role: "VIEWER", owner_scope: "ALL", team_ids: [1], pool_ids: [1], is_active: false, must_change_password: false },
];
const teams = [{ id: 1, code: "T1", name: "一队", is_active: true }];
const pools = [{ id: 1, name: "主池", code: "POOL-A", status: "ACTIVE" }];

beforeEach(() => {
  vi.mocked(client.api).get.mockImplementation(async (url: string) => {
    if (url === "/users") return { data: users };
    if (url === "/teams") return { data: teams };
    if (url === "/pools") return { data: pools };
    return { data: [] };
  });
  vi.mocked(client.api).post.mockResolvedValue({ data: {} });
  vi.mocked(client.api).patch.mockResolvedValue({ data: users[0] });
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
});

describe("UsersPanel.deep：写路径与失败分支", () => {
  it("新增用户成功：提交表单调用 api.post 并提示已创建", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<UsersPanel />, { user: "admin" });
    await screen.findByText("operator01");
    await ui.type(screen.getByPlaceholderText("用户名"), "newuser");
    await ui.type(screen.getByPlaceholderText("姓名"), "新同事");
    await ui.type(screen.getByPlaceholderText("初始密码（至少 8 位）"), "password123");
    await ui.click(screen.getByRole("button", { name: /新增用户/ }));
    await waitFor(() =>
      expect(vi.mocked(client.api).post).toHaveBeenCalledWith(
        "/users",
        expect.objectContaining({ username: "newuser", display_name: "新同事", password: "password123" }),
      ),
    );
    expect(message.success).toHaveBeenCalledWith("用户已创建");
  });

  it("新增用户失败：api.post reject 后 message.error", async () => {
    vi.mocked(client.api).post.mockRejectedValue(new Error("create fail"));
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<UsersPanel />, { user: "admin" });
    await screen.findByText("operator01");
    await ui.type(screen.getByPlaceholderText("用户名"), "newuser");
    await ui.type(screen.getByPlaceholderText("姓名"), "新同事");
    await ui.type(screen.getByPlaceholderText("初始密码（至少 8 位）"), "password123");
    await ui.click(screen.getByRole("button", { name: /新增用户/ }));
    await waitFor(() => expect(message.error).toHaveBeenCalled());
  });

  it("启用停用用户：is_active=false 行点启用调用 patch is_active:true", async () => {
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<UsersPanel />, { user: "admin" });
    await screen.findByText("viewer01");
    await ui.click(screen.getByRole("button", { name: /启用/ }));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    await waitFor(() => expect(vi.mocked(client.api).patch).toHaveBeenCalledWith("/users/8", { is_active: true }));
    expect(message.success).toHaveBeenCalledWith("用户已启用");
  });

  it("停用失败：api.patch reject 后 message.error", async () => {
    vi.mocked(client.api).patch.mockRejectedValue(new Error("toggle fail"));
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<UsersPanel />, { user: "admin" });
    await screen.findByText("operator01");
    await ui.click(screen.getByRole("button", { name: /停用/ }));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    await waitFor(() => expect(message.error).toHaveBeenCalled());
  });

  it("编辑失败：提交编辑后 api.patch reject 触发 message.error", async () => {
    vi.mocked(client.api).patch.mockRejectedValue(new Error("update fail"));
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<UsersPanel />, { user: "admin" });
    const row = (await screen.findByText("operator01")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /编辑/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "编辑用户：operator01" }));
    await ui.click(dialog.getByRole("button", { name: /OK/ }));
    await waitFor(() => expect(message.error).toHaveBeenCalled());
  });

  it("重置密码失败：提交后 api.post reject 触发 message.error", async () => {
    vi.mocked(client.api).post.mockRejectedValue(new Error("reset fail"));
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<UsersPanel />, { user: "admin" });
    const row = (await screen.findByText("operator01")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /重置密码/ }));
    const resetDialog = within(await screen.findByRole("dialog", { name: "重置密码：operator01" }));
    await ui.type(resetDialog.getByPlaceholderText("新密码（至少 8 位）"), "new-password");
    await ui.click(resetDialog.getByRole("button", { name: /OK/ }));
    await waitFor(() => expect(message.error).toHaveBeenCalled());
  });

  it("加载失败：api.get reject 后 message.error", async () => {
    vi.mocked(client.api).get.mockRejectedValue(new Error("load fail"));
    userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<UsersPanel />, { user: "admin" });
    await waitFor(() => expect(message.error).toHaveBeenCalled());
  });
});
