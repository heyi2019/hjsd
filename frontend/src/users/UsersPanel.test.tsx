import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { UsersPanel } from "./UsersPanel";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

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
});
