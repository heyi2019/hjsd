import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { UsersPanel } from "./UsersPanel";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

vi.mock("../shared/api/client", () => ({
  api,
  ACCESS_TOKEN_KEY: "access_token",
  DEV_USER_KEY: "dev_user",
  currentDevUser: () => "admin",
  setDevUser: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  errorMessage: (error: unknown) => String(error),
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
  api.get.mockResolvedValue({ data: [user] });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: user });
});

describe("UsersPanel：用户管理动作", () => {
  it("管理员可以编辑用户并提交更新", async () => {
    const ui = userEvent.setup();
    renderApp(<UsersPanel />, { user: "admin" });

    expect(await screen.findByText("operator01")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /编辑/ }));
    const dialog = within(screen.getByRole("dialog", { name: "编辑用户：operator01" }));
    const name = dialog.getByDisplayValue("业务同事");
    await ui.clear(name);
    await ui.type(name, "新业务同事");
    await ui.click(dialog.getByRole("button", { name: /OK/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/users/7", expect.objectContaining({ display_name: "新业务同事" })));
  });

  it("管理员可以停用用户并重置密码", async () => {
    const ui = userEvent.setup();
    renderApp(<UsersPanel />, { user: "admin" });

    expect(await screen.findByText("operator01")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /停用/ }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/users/7", { is_active: false }));

    await ui.click(screen.getByRole("button", { name: /重置密码/ }));
    const resetDialog = within(screen.getByRole("dialog", { name: "重置密码：operator01" }));
    await ui.type(resetDialog.getByPlaceholderText("新密码（至少 8 位）"), "new-password");
    await ui.click(resetDialog.getByRole("button", { name: /OK/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/users/7/reset-password", { password: "new-password" }));
  });
});
