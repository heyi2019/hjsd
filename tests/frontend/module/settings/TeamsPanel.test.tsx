import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { TeamsPanel } from "@/users/TeamsPanel";

let ui: ReturnType<typeof userEvent.setup>;

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

type Team = { id: number; code: string; name: string; description?: string | null; is_active: boolean };

const activeTeam: Team = { id: 1, code: "T01", name: "核心团队", description: "主营", is_active: true };
const inactiveTeam: Team = { id: 2, code: "T02", name: "备用团队", description: null, is_active: false };

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.mocked(client.api).get.mockResolvedValue({ data: [activeTeam] });
  vi.mocked(client.api).post.mockResolvedValue({ data: {} });
  vi.mocked(client.api).patch.mockResolvedValue({ data: activeTeam });
  // renderLight 不挂 antd <App>，静态 message 会告警；spy 消除告警并支持断言。
  vi.spyOn(message, "error").mockImplementation(() => ({} as never));
  vi.spyOn(message, "success").mockImplementation(() => ({} as never));
});

describe("TeamsPanel：团队管理", () => {
  it("加载并渲染团队列表", async () => {
    renderLight(<TeamsPanel />, { user: "admin" });
    expect(await screen.findByText("T01")).toBeInTheDocument();
    expect(screen.getByText("核心团队")).toBeInTheDocument();
    expect(vi.mocked(client.api).get).toHaveBeenCalledWith("/teams");
  });

  it("空列表显示暂无团队", async () => {
    vi.mocked(client.api).get.mockResolvedValue({ data: [] });
    renderLight(<TeamsPanel />, { user: "admin" });
    expect(await screen.findByText("暂无团队")).toBeInTheDocument();
  });

  it("加载失败提示错误", async () => {
    vi.mocked(client.api).get.mockRejectedValue(new Error("teams down"));
    renderLight(<TeamsPanel />, { user: "admin" });
    await waitFor(() => expect(message.error).toHaveBeenCalled());
    expect(String(vi.mocked(message.error).mock.calls[0][0])).toMatch(/teams down/);
  });

  it("新增团队提交表单并写回", async () => {
    renderLight(<TeamsPanel />, { user: "admin" });
    await screen.findByText("T01");
    await ui.type(screen.getByPlaceholderText("团队编码"), "T03");
    await ui.type(screen.getByPlaceholderText("团队名称"), "新团队");
    await ui.type(screen.getByPlaceholderText("说明（可选）"), "测试");
    await ui.click(screen.getByRole("button", { name: /新增团队/ }));
    await waitFor(() =>
      expect(vi.mocked(client.api).post).toHaveBeenCalledWith(
        "/teams",
        expect.objectContaining({ code: "T03", name: "新团队", description: "测试" }),
      ),
    );
    // 成功后重新加载（api.get 至少被调两次：初次 + 写回）。
    expect(vi.mocked(client.api).get).toHaveBeenCalledTimes(2);
    expect(vi.mocked(message.success)).toHaveBeenCalledWith("团队已创建");
  });

  it("重复团队编码在前端拦截并保留表单", async () => {
    renderLight(<TeamsPanel />, { user: "admin" });
    await screen.findByText("T01");
    await ui.type(screen.getByPlaceholderText("团队编码"), " t01 ");
    await ui.type(screen.getByPlaceholderText("团队名称"), "重复团队");
    await ui.click(screen.getByRole("button", { name: /新增团队/ }));

    await waitFor(() => expect(message.error).toHaveBeenCalledWith("团队编码已存在"));
    expect(screen.getByPlaceholderText("团队编码")).toHaveValue(" t01 ");
    expect(vi.mocked(client.api).post).not.toHaveBeenCalled();
  });

  it("新增失败提示错误", async () => {
    vi.mocked(client.api).post.mockRejectedValue(new Error("create fail"));
    renderLight(<TeamsPanel />, { user: "admin" });
    await screen.findByText("T01");
    await ui.type(screen.getByPlaceholderText("团队编码"), "T03");
    await ui.type(screen.getByPlaceholderText("团队名称"), "新团队");
    await ui.click(screen.getByRole("button", { name: /新增团队/ }));
    await waitFor(() => expect(message.error).toHaveBeenCalled());
    expect(String(vi.mocked(message.error).mock.calls[0][0])).toMatch(/create fail/);
  });

  it("新增团队字段提供持久可访问标签", async () => {
    renderLight(<TeamsPanel />, { user: "admin" });
    await screen.findByText("T01");
    expect(screen.getByLabelText("团队编码")).toBeInTheDocument();
    expect(screen.getByLabelText("团队名称")).toBeInTheDocument();
    expect(screen.getByLabelText("说明")).toBeInTheDocument();
  });

  it("停用团队需二次确认", async () => {
    renderLight(<TeamsPanel />, { user: "admin" });
    await screen.findByText("T01");
    await ui.click(screen.getByRole("button", { name: /停用/ }));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    await waitFor(() =>
      expect(vi.mocked(client.api).patch).toHaveBeenCalledWith("/teams/1", { is_active: false }),
    );
    expect(vi.mocked(message.success)).toHaveBeenCalledWith("团队已停用");
  });

  it("启用团队需二次确认", async () => {
    vi.mocked(client.api).get.mockResolvedValue({ data: [inactiveTeam] });
    renderLight(<TeamsPanel />, { user: "admin" });
    await screen.findByText("T02");
    await ui.click(screen.getByRole("button", { name: /启用/ }));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    await waitFor(() =>
      expect(vi.mocked(client.api).patch).toHaveBeenCalledWith("/teams/2", { is_active: true }),
    );
    expect(vi.mocked(message.success)).toHaveBeenCalledWith("团队已启用");
  });

  it("切换状态失败提示错误", async () => {
    vi.mocked(client.api).patch.mockRejectedValue(new Error("toggle fail"));
    renderLight(<TeamsPanel />, { user: "admin" });
    await screen.findByText("T01");
    await ui.click(screen.getByRole("button", { name: /停用/ }));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    await waitFor(() => expect(message.error).toHaveBeenCalled());
    expect(String(vi.mocked(message.error).mock.calls[0][0])).toMatch(/toggle fail/);
  });
});
