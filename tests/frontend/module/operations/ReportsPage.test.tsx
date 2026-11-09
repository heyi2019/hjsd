import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { ReportsPage } from "@/reporting/ReportsPage";
import { resolveMock } from "@fixtures/mock-api";
import { appMessage } from "@/shared/ui/appFeedback";

import * as catalog from "@/shared/api/catalog";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

// jsdom 不执行真实下载跳转；屏蔽 anchor.click，避免导出测试留下 navigation 定时器拖住全量单测。
// 同时 jsdom 未实现 URL.createObjectURL/revokeObjectURL，导出成功分支依赖它，置为安全桩。
// 必须在「每个用例」的 beforeEach 内（clearAllMocks 之后）重新挂桩：setup.ts 的 afterEach 会
// resetAllMocks，清空 beforeAll 桩的 mockReturnValue；若是文件内后续用例（如「导出成功后」）
// 会读到真实 jsdom Blob 而抛 "cannot read the bytes of a jsdom Blob"，误入错误分支。
vi.mock("@/shared/api/catalog")

vi.mock("@/shared/ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { LightweightDataTable } = await import("@fixtures/LightweightDataTable");
  return { ...actual, DataTable: LightweightDataTable };
});

const emptyHealth = { generated_on: "2026-10-01", total_cost: "0.00", items: [] };

beforeEach(() => {
  vi.clearAllMocks();
  // 每个用例重新挂桩，覆盖上一份用例 afterEach(resetAllMocks) 对桩实现的清空。
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  resolveMock(vi.mocked(catalog.reportsApi.inventoryHealth), emptyHealth);
  resolveMock(vi.mocked(catalog.reportsApi.monthlyPnl), { items: [], total: {} });
  resolveMock(vi.mocked(catalog.reportsApi.commission), { items: [], total: { order_count: 0, payable: "0", paid: "0", difference: "0" } });
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([
    { id: 7, username: "operator", display_name: "业务同事", is_active: true },
    { id: 8, username: "finance", display_name: "财务同事", is_active: true },
  ]);
  resolveMock(vi.mocked(catalog.reportsApi.dailyFunds), { date: "2026-10-01", total: {}, items: [] });
  resolveMock(vi.mocked(catalog.reportsApi.businessPnl), { items: [], total: {} });
  resolveMock(vi.mocked(catalog.reportsApi.orderProfit), { items: [], total: { income: "0", direct_cost: "0", rebate: "0", net_profit: "0" } });
  resolveMock(vi.mocked(catalog.reportsApi.exportCsv), new Blob(["csv"]));
});

async function gotoTab(label: string) {
  await ui.click(screen.getByRole("tab", { name: label }));
}

describe("ReportsPage：经营中心报表", () => {
  it("初始只加载当前激活的库存报表，不提前加载隐藏 Tab", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "库存 R1" });
    expect(vi.mocked(catalog.reportsApi.inventoryHealth)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(catalog.reportsApi.monthlyPnl)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.reportsApi.commission)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.reportsApi.dailyFunds)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.reportsApi.businessPnl)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.reportsApi.orderProfit)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.poolsApi.list)).not.toHaveBeenCalled();
  });

  it("我的收益只加载当前登录用户的分润记录", async () => {
    renderLight(<ReportsPage initialReportTab="my-earnings" />, { user: "admin" });
    const commissionTab = await screen.findByRole("tab", { name: "提成对账 R3" });
    expect(commissionTab).toHaveAttribute("aria-selected", "true");
    expect((await screen.findAllByText("我的收益")).length).toBeGreaterThan(0);
    expect(vi.mocked(catalog.reportsApi.commission)).toHaveBeenCalledWith({ mine: true });
    expect(vi.mocked(catalog.reportsApi.inventoryHealth)).not.toHaveBeenCalled();
  });

  it("FE-260：提成对账可以按人员筛选并传递 user_id", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await ui.click(screen.getByRole("tab", { name: "提成对账 R3" }));
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.commission)).toHaveBeenLastCalledWith({ all_people: true }));
    await waitFor(() => expect(vi.mocked(catalog.employeesApi.list)).toHaveBeenCalled());
    const personComboboxes = await screen.findAllByRole("combobox");
    const personFilter = personComboboxes[personComboboxes.length - 1] as HTMLElement;
    await ui.click(personFilter);
    expect(await screen.findByText("全部", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    await ui.click(await screen.findByText(/业务同事（operator）/, { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.commission)).toHaveBeenLastCalledWith({ all_people: true, user_id: 7 }));
  });

  it("六个核心 Tab 齐全（R1-R5 + 订单利润）", async () => {
    renderLight(<ReportsPage />, { user: "admin" });
    await screen.findByRole("tab", { name: "库存 R1" });
    for (const label of ["库存 R1", "月度损益 R2", "提成对账 R3", "资金报表·日报", "业务损益 R5", "订单利润"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
  });

  it("订单利润页内导出按钮按统计周期导出", async () => {
    vi.spyOn(appMessage, "success").mockImplementation((() => undefined) as never);
    renderLight(<ReportsPage />, { user: "admin" });
    await gotoTab("订单利润");
    // 报表统计周期 picker：激活 Tab 面板内的两枚日期输入
    const pane = document.querySelector(".ant-tabs-tabpane-active") as HTMLElement;
    const dateInputs = pane.querySelectorAll<HTMLInputElement>(".ui-control-width-date");
    expect(screen.getByLabelText("报表开始日期")).toBeInTheDocument();
    expect(screen.getByLabelText("报表结束日期")).toBeInTheDocument();
    await ui.type(dateInputs[0], "2026-01-01");
    await ui.type(dateInputs[1], "2026-01-31");
    await ui.click(screen.getByRole("button", { name: "导出 CSV" }));
    await waitFor(() => expect(vi.mocked(catalog.reportsApi.exportCsv)).toHaveBeenCalledWith("order-profit", { from: "2026-01-01", to: "2026-01-31" }));
  });

});
