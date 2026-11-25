import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AppShell } from "@/app/AppShell";
import * as client from "@/shared/api/client";
import { renderApp } from "@fixtures/render";

afterEach(() => {
  vi.restoreAllMocks();
});

it("FE-207：修改密码请求未返回时仍可关闭真实用户中心弹窗", async () => {
  vi.spyOn(client, "changePassword").mockReturnValue(new Promise(() => undefined));
  renderApp(
    <MemoryRouter initialEntries={["/workbench"]}>
      <AppShell />
    </MemoryRouter>,
    { user: "admin" },
  );

  fireEvent.click(await screen.findByRole("button", { name: "用户中心" }));
  const dialog = await screen.findByRole("dialog");
  const passwordCard = within(dialog).getByText("修改密码", { selector: ".ant-card-head-title" }).closest(".ant-card") as HTMLElement;
  fireEvent.change(within(passwordCard).getByLabelText("当前密码"), { target: { value: "wrong-old-pass" } });
  fireEvent.change(within(dialog).getByLabelText("新密码"), { target: { value: "new-pass-12345" } });
  fireEvent.change(within(dialog).getByLabelText("确认新密码"), { target: { value: "new-pass-12345" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /修改密码/ }));

  await waitFor(() => expect(client.changePassword).toHaveBeenCalledWith("wrong-old-pass", "new-pass-12345"));
  expect(within(dialog).getByRole("button", { name: /修改密码/ })).toHaveClass("ant-btn-loading");
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  });

  await waitFor(() => expect(screen.getByRole("button", { name: "用户中心" })).toHaveAttribute("data-user-center-open", "false"));
});
