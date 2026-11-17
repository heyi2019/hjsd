import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { PoolsPanel } from "@/field-definitions/panels/PoolsPanel";
import { poolsApi } from "@/shared/api/pools.api";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

const pools = [
  { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "INVEST", ownership: "OWNED", status: "ACTIVE", note: "x" },
  { id: 2, code: "HJ_PROFIT", name: "利润池", pool_type: "PROFIT", ownership: "CUSTODY", status: "DISABLED", note: null },
];

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(poolsApi).list.mockResolvedValue(pools);
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

  it("新建资金账户成功：提交 create + 重新加载", async () => {
    renderLight(<PoolsPanel />, { user: "admin" });
    await screen.findByText("托管池");
    await ui.type(screen.getByPlaceholderText("请输入资金账户编码"), "NEW_POOL");
    await ui.type(screen.getByPlaceholderText("显示名"), "新池");
    await ui.click(screen.getByRole("button", { name: /新增资金账户/ }));
    await waitFor(() =>
      expect(vi.mocked(poolsApi.create)).toHaveBeenCalledWith({
        code: "NEW_POOL",
        name: "新池",
        pool_type: "OTHER",
        ownership: "OWNED",
        is_default: false,
      }),
    );
    expect(message.success).toHaveBeenCalledWith("资金账户已创建");
    await waitFor(() => expect(vi.mocked(poolsApi.list)).toHaveBeenCalledTimes(2));
  });

  it("新建资金账户失败：错误横幅", async () => {
    vi.mocked(poolsApi).create.mockRejectedValue(new Error("create fail"));
    renderLight(<PoolsPanel />, { user: "admin" });
    await screen.findByText("托管池");
    await ui.type(screen.getByPlaceholderText("请输入资金账户编码"), "BAD");
    await ui.type(screen.getByPlaceholderText("显示名"), "坏池");
    await ui.click(screen.getByRole("button", { name: /新增资金账户/ }));
    expect(await screen.findByText(/create fail/)).toBeInTheDocument();
  });

  it("编辑保存成功：调用 update", async () => {
    renderLight(<PoolsPanel />, { user: "admin" });
    const row = (await screen.findByText("托管池")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /编辑/ }));
    const modal = (await screen.findByText(/编辑资金账户 · HJ_CUSTODY/)).closest(".ant-modal-content") as HTMLElement;
    const nameInput = within(modal).getByDisplayValue("托管池") as HTMLInputElement;
    await ui.clear(nameInput);
    await ui.type(nameInput, "托管池改");
    await ui.click(within(modal).getByRole("button", { name: /保存/ }));
    await waitFor(() =>
      expect(vi.mocked(poolsApi.update)).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ name: "托管池改", pool_type: "INVEST", ownership: "OWNED" }),
      ),
    );
    expect(message.success).toHaveBeenCalledWith("资金账户已更新");
  });

  it("编辑保存失败：错误横幅", async () => {
    vi.mocked(poolsApi).update.mockRejectedValue(new Error("update fail"));
    renderLight(<PoolsPanel />, { user: "admin" });
    const row = (await screen.findByText("托管池")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /编辑/ }));
    const modal = (await screen.findByText(/编辑资金账户 · HJ_CUSTODY/)).closest(".ant-modal-content") as HTMLElement;
    await ui.click(within(modal).getByRole("button", { name: /保存/ }));
    expect(await within(modal).findByText(/update fail/)).toBeInTheDocument();
  });

  it("停用（ConfirmButton）：setStatus(id, DISABLED)", async () => {
    renderLight(<PoolsPanel />, { user: "admin" });
    const row = (await screen.findByText("托管池")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /停用/ }));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    await waitFor(() => expect(vi.mocked(poolsApi.setStatus)).toHaveBeenCalledWith(1, "DISABLED"));
    expect(message.success).toHaveBeenCalledWith("资金账户已停用");
  });

  it("启用（ConfirmButton）：setStatus(id, ACTIVE)", async () => {
    renderLight(<PoolsPanel />, { user: "admin" });
    const row = (await screen.findByText("利润池")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /启用/ }));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    await waitFor(() => expect(vi.mocked(poolsApi.setStatus)).toHaveBeenCalledWith(2, "ACTIVE"));
    expect(message.success).toHaveBeenCalledWith("资金账户已启用");
  });

  it("无 pool.manage 权限时隐藏操作并展示 fallback", async () => {
    renderLight(<PoolsPanel />, { user: "operator" });
    expect(await screen.findByText("当前角色无主数据维护权限。")).toBeInTheDocument();
    const row = (await screen.findByText("托管池")).closest("tr") as HTMLElement;
    expect(within(row).queryByRole("button", { name: /编辑/ })).toBeNull();
    expect(within(row).queryByRole("button", { name: /停用/ })).toBeNull();
  });

  it("加载失败：错误横幅 + 重新加载重试", async () => {
    vi.mocked(poolsApi).list
      .mockRejectedValueOnce(new Error("pools down"))
      .mockResolvedValue(pools);
    renderLight(<PoolsPanel />, { user: "admin" });
    expect(await screen.findByText(/pools down/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新增资金账户/ })).toBeDisabled();
    expect(screen.getByText("资金账户数据不可用，请点击重新加载")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await waitFor(() => expect(vi.mocked(poolsApi.list)).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("托管池")).toBeInTheDocument();
  });
});
