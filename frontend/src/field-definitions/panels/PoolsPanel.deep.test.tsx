import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { message } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";
import { PoolsPanel } from "./PoolsPanel";
import * as catalog from "../../shared/api/catalog";

vi.mock("../../shared/api/catalog");

const pools = [
  { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "INVEST", ownership: "OWNED", status: "ACTIVE", note: "x" },
  { id: 2, code: "HJ_PROFIT", name: "利润池", pool_type: "PROFIT", ownership: "CUSTODY", status: "DISABLED", note: null },
];

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(catalog.poolsApi).list.mockResolvedValue(pools);
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
});

describe("PoolsPanel.deep", () => {
  it("渲染：类型标签 / 归属标签 / 状态", async () => {
    renderLight(<PoolsPanel />, { user: "admin" });
    expect(await screen.findByText("托管池")).toBeInTheDocument();
    // POOL_TYPE_LABEL
    expect(screen.getByText("投资款")).toBeInTheDocument();
    expect(screen.getByText("利润")).toBeInTheDocument();
    // POOL_OWNERSHIP_LABEL
    expect(screen.getByText("自有")).toBeInTheDocument();
    expect(screen.getByText("代管")).toBeInTheDocument();
  });

  it("新建资金池成功：提交 create + 重新加载", async () => {
    renderLight(<PoolsPanel />, { user: "admin" });
    await screen.findByText("托管池");
    await ui.type(screen.getByPlaceholderText("池代码，如 HJ_CUSTODY"), "NEW_POOL");
    await ui.type(screen.getByPlaceholderText("显示名"), "新池");
    await ui.click(screen.getByRole("button", { name: /新增资金池/ }));
    await waitFor(() =>
      expect(vi.mocked(catalog.poolsApi.create)).toHaveBeenCalledWith({
        code: "NEW_POOL",
        name: "新池",
        pool_type: "OTHER",
        ownership: "OWNED",
      }),
    );
    expect(message.success).toHaveBeenCalledWith("资金池已创建");
    await waitFor(() => expect(vi.mocked(catalog.poolsApi.list)).toHaveBeenCalledTimes(2));
  });

  it("新建资金池失败：错误横幅", async () => {
    vi.mocked(catalog.poolsApi).create.mockRejectedValue(new Error("create fail"));
    renderLight(<PoolsPanel />, { user: "admin" });
    await screen.findByText("托管池");
    await ui.type(screen.getByPlaceholderText("池代码，如 HJ_CUSTODY"), "BAD");
    await ui.type(screen.getByPlaceholderText("显示名"), "坏池");
    await ui.click(screen.getByRole("button", { name: /新增资金池/ }));
    expect(await screen.findByText(/create fail/)).toBeInTheDocument();
  });

  it("编辑保存成功：调用 update", async () => {
    renderLight(<PoolsPanel />, { user: "admin" });
    const row = (await screen.findByText("托管池")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /编辑/ }));
    const modal = (await screen.findByText(/编辑资金池 · HJ_CUSTODY/)).closest(".ant-modal-content") as HTMLElement;
    const nameInput = within(modal).getByDisplayValue("托管池") as HTMLInputElement;
    await ui.clear(nameInput);
    await ui.type(nameInput, "托管池改");
    await ui.click(within(modal).getByRole("button", { name: /保存/ }));
    await waitFor(() =>
      expect(vi.mocked(catalog.poolsApi.update)).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ name: "托管池改", pool_type: "INVEST", ownership: "OWNED" }),
      ),
    );
    expect(message.success).toHaveBeenCalledWith("资金池已更新");
  });

  it("编辑保存失败：错误横幅", async () => {
    vi.mocked(catalog.poolsApi).update.mockRejectedValue(new Error("update fail"));
    renderLight(<PoolsPanel />, { user: "admin" });
    const row = (await screen.findByText("托管池")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /编辑/ }));
    const modal = (await screen.findByText(/编辑资金池 · HJ_CUSTODY/)).closest(".ant-modal-content") as HTMLElement;
    await ui.click(within(modal).getByRole("button", { name: /保存/ }));
    expect(await screen.findByText(/update fail/)).toBeInTheDocument();
  });

  it("停用（ConfirmButton）：setStatus(id, DISABLED)", async () => {
    renderLight(<PoolsPanel />, { user: "admin" });
    const row = (await screen.findByText("托管池")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /停用/ }));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    await waitFor(() => expect(vi.mocked(catalog.poolsApi.setStatus)).toHaveBeenCalledWith(1, "DISABLED"));
    expect(message.success).toHaveBeenCalledWith("资金池已停用");
  });

  it("启用（ConfirmButton）：setStatus(id, ACTIVE)", async () => {
    renderLight(<PoolsPanel />, { user: "admin" });
    const row = (await screen.findByText("利润池")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /启用/ }));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    await waitFor(() => expect(vi.mocked(catalog.poolsApi.setStatus)).toHaveBeenCalledWith(2, "ACTIVE"));
    expect(message.success).toHaveBeenCalledWith("资金池已启用");
  });

  it("无 pool.manage 权限时隐藏操作并展示 fallback", async () => {
    renderLight(<PoolsPanel />, { user: "operator" });
    expect(await screen.findByText("当前角色无主数据维护权限。")).toBeInTheDocument();
    const row = (await screen.findByText("托管池")).closest("tr") as HTMLElement;
    expect(within(row).queryByRole("button", { name: /编辑/ })).toBeNull();
    expect(within(row).queryByRole("button", { name: /停用/ })).toBeNull();
  });

  it("加载失败：错误横幅 + 重新加载重试", async () => {
    vi.mocked(catalog.poolsApi).list
      .mockRejectedValueOnce(new Error("pools down"))
      .mockResolvedValue(pools);
    renderLight(<PoolsPanel />, { user: "admin" });
    expect(await screen.findByText(/pools down/)).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await waitFor(() => expect(vi.mocked(catalog.poolsApi.list)).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("托管池")).toBeInTheDocument();
  });
});
