/** StudioExpensePanel：工作室支出登记与资金池筛选。 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { resolveMockOnce } from "@fixtures/mock-api";
import { cashflowsApi } from "@/shared/api/cashflows.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { StudioExpensePanel } from "@/pools/StudioExpensePanel";

let ui: ReturnType<typeof userEvent.setup>;

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
  { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
  { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", ownership: "SELF", status: "ACTIVE" },
];

const expenseFlows = [
  {
    id: 51, flow_no: "CF-001", pool_id: 1, occurred_on: "2026-10-20", nature: "BUSINESS_OUT",
    category: "房租", direction: "OUT", amount: "3000.00", source: "OTHER", status: "APPROVED",
    fund_nature: "BUSINESS", accounting_attribute: "OPERATING_EXPENSE",
  },
  {
    id: 52, flow_no: "CF-002", pool_id: 2, occurred_on: "2026-10-21", nature: "BUSINESS_OUT",
    category: "日用", direction: "OUT", amount: "100.00", source: "OTHER", status: "PENDING",
    fund_nature: "BUSINESS", accounting_attribute: "OPERATING_EXPENSE",
  },
];

function mockOptionSets() {
  vi.mocked(optionSetsApi.get).mockImplementation(async (code: string) => {
    if (code === "STUDIO_EXPENSE_ITEM") {
      return {
        id: 92, code, label: "工作室支出费用科目", group: "FUND", editable: true,
        options: [
          { value: "房租", label: "房租" },
          { value: "日用", label: "日用" },
        ],
      } as never;
    }
    throw new Error(`unexpected option set: ${code}`);
  });
}

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  // 明细与三项汇总一次取回；「什么算工作室收支」的口径在 backend
  // tests/v1/test_studio_cashflow_summary.py，这里只验展示。
  vi.mocked(cashflowsApi.studioSummary).mockResolvedValue({
    items: expenseFlows as never,
    approved_income: "0.00",
    approved_expense: "3000.00",
    approved_net: "-3000.00",
    count: expenseFlows.length,
  });
});

async function pickSelect(modal: HTMLElement, index: number, title: RegExp) {
  await ui.click(modal.querySelectorAll(".ant-select-selector")[index] as Element);
  const dropdowns = document.querySelectorAll(".ant-select-dropdown");
  const current = dropdowns[dropdowns.length - 1] as HTMLElement;
  await ui.click(await within(current).findByTitle(title));
}

/** 收支是分段控件（不是下拉），选项直接可点，不再有下拉弹层。 */
async function pickDirection(modal: HTMLElement, label: "支出" | "收入") {
  const item = Array.from(modal.querySelectorAll(".ant-segmented-item")).find((el) =>
    el.textContent?.trim().startsWith(label),
  );
  if (!item) throw new Error(`未找到收支分段项：${label}`);
  await ui.click(item);
}

async function togglePoolFilter(title: RegExp) {
  await ui.click(screen.getByRole("combobox", { name: "资金池筛选" }));
  const dropdowns = document.querySelectorAll(".ant-select-dropdown");
  const current = dropdowns[dropdowns.length - 1] as HTMLElement;
  await ui.click(await within(current).findByTitle(title));
}

describe("StudioExpensePanel：工作室支出", () => {
  it("资金池直接使用多选下拉筛选，不再显示复选框", async () => {
    mockOptionSets();
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });

    expect(screen.queryByRole("button", { name: /配置承载池/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /经营主池/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "资金池筛选" })).toBeInTheDocument();

    await togglePoolFilter(/押金池/);
    // 列表过滤在后端：取消押金池后请求只带 POOL-A
    expect(vi.mocked(cashflowsApi.studioSummary)).toHaveBeenLastCalledWith(
      expect.objectContaining({ pool_ids: "1" }),
    );
  });

  it("资金池筛选下拉只显示中文名称，不显示英文编码", async () => {
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    const poolSelect = await screen.findByRole("combobox", { name: "资金池筛选" });
    await ui.click(poolSelect);
    // 断言必须限定在弹层内：列表「资金池」列同样渲染「经营主池」，
    // 全局 getByText 会命中多个（实测 2 处）而误报。
    const dropdowns = document.querySelectorAll(".ant-select-dropdown");
    const current = dropdowns[dropdowns.length - 1] as HTMLElement;
    expect(within(current).getByText("经营主池")).toBeInTheDocument();
    expect(within(current).queryByText("POOL-A")).not.toBeInTheDocument();
  });

  it("记一笔按钮独立于筛选栏", async () => {
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");

    expect(screen.getByRole("button", { name: /记一笔/ })).toBeInTheDocument();
    expect(document.querySelector(".studio-expense-filters")?.querySelector("button")).toBeNull();
  });

  it("筛选项位于统计卡片下方", async () => {
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");
    const stats = document.querySelector(".ui-stat-row");
    const filters = document.querySelector(".studio-expense-filters");
    expect(stats).toBeTruthy();
    expect(filters).toBeTruthy();
    expect(Boolean(stats && filters && (stats.compareDocumentPosition(filters) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  });

  it("工作室支出卡片使用宽松布局钩子，避免筛选器和统计卡片挤在一起", async () => {
    // 原写法调用了不存在的 renderPanel()（本文件唯一用例），按其余用例口径改回 renderLight
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    expect(await screen.findByText("已入账收入")).toBeInTheDocument();
    expect(document.querySelector(".studio-expense-card")).toBeInTheDocument();
  });

  it("资金池筛选位于全部科目右侧并给下拉足够宽度", async () => {
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");

    const filters = document.querySelector(".studio-expense-filters") as HTMLElement;
    expect(filters).toHaveClass("studio-expense-filters--single-row");
    expect(filters.querySelector(".ui-control-width-studio-pool")).toBeInTheDocument();
    expect(filters.textContent?.indexOf("全部科目")).toBeLessThan(filters.textContent?.indexOf("资金池筛选"));
  });

  it("工作室支出筛选区不显示查询按钮", async () => {
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");

    expect(screen.queryByRole("button", { name: /查询/ })).not.toBeInTheDocument();
  });

  it("费用科目配置入口统一放在设置配置中心", async () => {
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");
    expect(screen.queryByRole("button", { name: "配置费用科目" })).not.toBeInTheDocument();
  });

  it("无审批流程时不显示状态筛选", async () => {
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");
    expect(screen.queryByRole("combobox", { name: "工作室支出状态" })).not.toBeInTheDocument();
    expect(screen.queryByText("全部状态")).not.toBeInTheDocument();
  });

  it("不显示工作室收支标题文字", async () => {
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");

    expect(screen.queryByText("工作室收支", { selector: ".ant-card-head-title" })).not.toBeInTheDocument();
  });

  it("未选择资金池时给出引导提示，且列表为空", async () => {
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByRole("combobox", { name: "资金池筛选" });
    await togglePoolFilter(/经营主池/);
    await togglePoolFilter(/押金池/);
    expect(await screen.findByText(/尚未选择资金池/)).toBeInTheDocument();
    expect(screen.getByText("暂无工作室收支")).toBeInTheDocument();
  });

  it("资金池筛选随请求下发 pool_ids，前端不再自行过滤", async () => {
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    expect(await screen.findByText("房租")).toBeInTheDocument();
    // 默认勾选全部池
    expect(vi.mocked(cashflowsApi.studioSummary)).toHaveBeenLastCalledWith(
      expect.objectContaining({ pool_ids: "1,2" }),
    );
    await togglePoolFilter(/押金池/);
    // 取消押金池后只剩 POOL-A；「只显示这些池的流水」由后端按 pool_ids 筛
    expect(vi.mocked(cashflowsApi.studioSummary)).toHaveBeenLastCalledWith(
      expect.objectContaining({ pool_ids: "1" }),
    );
  });

  it("三个汇总数取服务端，不与当页明细相加", async () => {
    // 故意让后端汇总与两条明细（3000 + 100）对不上：卡片必须显示后端值。
    vi.mocked(cashflowsApi.studioSummary).mockResolvedValue({
      items: expenseFlows as never,
      approved_income: "888.88",
      approved_expense: "777.77",
      approved_net: "111.11",
      count: 2,
    });
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");

    const cardOf = (label: string) => screen.getByText(label).closest(".ui-stat") as HTMLElement;
    expect(within(cardOf("已入账收入")).getByText("888.88")).toBeInTheDocument();
    expect(within(cardOf("已入账支出")).getByText("777.77")).toBeInTheDocument();
    expect(within(cardOf("净额")).getByText("111.11")).toBeInTheDocument();
  });

  it("日期筛选和登记日期复用库存中心的日期选择器", async () => {
    mockOptionSets();
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });

    await screen.findByText("房租");
    expect(screen.getByPlaceholderText("开始日期")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("结束日期")).toBeInTheDocument();
    expect(screen.getAllByLabelText("工作室支出日期区间")).toHaveLength(2);

    await ui.click(await screen.findByRole("button", { name: /记一笔/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    expect(modal.querySelector(".ant-picker")).toBeInTheDocument();
  });

  it("工作室收支表补齐流水号、来源和建立时间字段", async () => {
    mockOptionSets();
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });

    await screen.findByText("房租");
    for (const label of ["流水号", "来源", "建立时间"]) {
      expect(screen.getByRole("columnheader", { name: label })).toBeInTheDocument();
    }
  });

  it("登记支出：提交即入账（OUT / BUSINESS_OUT / OPERATING_EXPENSE）", async () => {
    mockOptionSets();
    resolveMockOnce(vi.mocked(cashflowsApi.create), { id: 61 });
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");
    await ui.click(await screen.findByRole("button", { name: /记一笔/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, 0, /经营主池/);
    // 收支改为分段控件后，科目从第 3 个下拉前移到第 2 个
    await pickSelect(modal, 1, /房租/);
    await ui.type(modal.querySelector("#amount") ?? modal, "3000.00");
    await ui.type(modal.querySelector("#note") ?? modal, "10 月工作室房租");
    await ui.click(screen.getByRole("button", { name: /登记入账/ }));
    await waitFor(() => expect(vi.mocked(cashflowsApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(cashflowsApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      pool_id: 1,
      direction: "OUT",
      nature: "BUSINESS_OUT",
      fund_nature: "BUSINESS",
      accounting_attribute: "OPERATING_EXPENSE",
      category: "房租",
      amount: "3000.00",
    });
  });

  it("流水列表拉取失败时禁用记一笔入口并展示错误重试", async () => {
    mockOptionSets();
    vi.mocked(cashflowsApi.studioSummary).mockRejectedValue(new Error("流水读取失败"));
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    const recordBtn = await screen.findByRole("button", { name: /记一笔/ });
    await waitFor(() => expect(recordBtn).toBeDisabled());
    expect(screen.getByText(/流水读取失败/)).toBeInTheDocument();
  });

  it("登记收入：IN / BUSINESS_IN / SELF_REVENUE，同样自动入账", async () => {
    mockOptionSets();
    resolveMockOnce(vi.mocked(cashflowsApi.create), { id: 62 });
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");
    await ui.click(await screen.findByRole("button", { name: /记一笔/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, 0, /经营主池/);
    await pickDirection(modal, "收入");
    await pickSelect(modal, 1, /货款/);
    await ui.type(modal.querySelector("#amount") ?? modal, "800.00");
    await ui.click(screen.getByRole("button", { name: /登记入账/ }));
    await waitFor(() => expect(vi.mocked(cashflowsApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(cashflowsApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      pool_id: 1,
      direction: "IN",
      nature: "BUSINESS_IN",
      fund_nature: "BUSINESS",
      accounting_attribute: "SELF_REVENUE",
      category: "货款",
      amount: "800.00",
    });
  });

});
