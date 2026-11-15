import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { InventoryPanel } from "@/stocks/InventoryPanel";
import { stocksApi } from "@/shared/api/stocks.api";
import { setupInventoryPanelMocks } from "@fixtures/InventoryPanel.test.fixtures";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/orderCashflows.api");
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
setupInventoryPanelMocks();

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.mocked(stocksApi.remove).mockResolvedValue(undefined);
});

describe("InventoryPanel：删除二次确认", () => {
  it("管理员可删除，原因必填，确认后才调用删除接口并刷新台账", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });

    const deleteButtons = await screen.findAllByRole("button", { name: "删除" });
    expect(deleteButtons.length).toBeGreaterThan(0);
    await ui.click(deleteButtons[0]);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("删除")).toBeInTheDocument();
    expect(within(dialog).getByText(/此操作不可恢复，请二次确认/)).toBeInTheDocument();
    const reasonInput = within(dialog).getByRole("textbox", { name: "删除原因" });
    const confirm = within(dialog).getByRole("button", { name: "确认删除" });

    // 空原因：表单校验拦住，绝不发请求。
    await ui.click(confirm);
    expect(await within(dialog).findByText("请填写删除原因")).toBeInTheDocument();
    expect(stocksApi.remove).not.toHaveBeenCalled();

    await ui.type(reasonInput, "重复录入，需清理");
    await ui.click(confirm);
    await waitFor(() => {
      expect(stocksApi.remove).toHaveBeenCalledWith(1, "重复录入，需清理");
    });
    // 删除成功后重拉列表（首次渲染 + 删除后各一次）。
    await waitFor(() => {
      expect(stocksApi.list).toHaveBeenCalledTimes(2);
    });
    // 不断言弹窗 DOM 是否消失：jsdom + antd Modal 在 open=false 后不移除节点，
    // 关闭行为须由真实浏览器验收（本仓既有结论，单测只锁请求与副作用）。
  });

  it("纯空白原因同样被拦下", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });

    const deleteButtons = await screen.findAllByRole("button", { name: "删除" });
    await ui.click(deleteButtons[0]);
    const dialog = await screen.findByRole("dialog");
    await ui.type(within(dialog).getByRole("textbox", { name: "删除原因" }), "   ");
    await ui.click(within(dialog).getByRole("button", { name: "确认删除" }));

    expect(await within(dialog).findByText("删除原因不能为空")).toBeInTheDocument();
    expect(stocksApi.remove).not.toHaveBeenCalled();
  });

  it("非管理员看不到删除键", async () => {
    renderLight(<InventoryPanel />, { user: "operator" });

    await screen.findByPlaceholderText("搜索游戏账号/产品 / 游戏/产品类型 / 平台");
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });

  it("删除失败时弹窗保持打开，可改原因重试", async () => {
    vi.mocked(stocksApi.remove).mockRejectedValue(new Error("该账号存在分期处置记录"));
    renderLight(<InventoryPanel />, { user: "admin" });

    const deleteButtons = await screen.findAllByRole("button", { name: "删除" });
    await ui.click(deleteButtons[0]);
    const dialog = await screen.findByRole("dialog");
    await ui.type(within(dialog).getByRole("textbox", { name: "删除原因" }), "尝试删除");
    await ui.click(within(dialog).getByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(stocksApi.remove).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
