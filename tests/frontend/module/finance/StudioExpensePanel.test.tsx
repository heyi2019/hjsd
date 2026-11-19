/** StudioExpensePanel：工作室支出登记。 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { resolveMockOnce } from "@fixtures/mock-api";
import { cashflowsApi } from "@/shared/api/cashflows.api";
import { studioExpensesApi } from "@/shared/api/studioExpenses.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { employeesApi } from "@/shared/api/org.api";
import { StudioExpensePanel } from "@/pools/StudioExpensePanel";
import { studioExpenseSummary } from "@fixtures/api-responses";

let ui: ReturnType<typeof userEvent.setup>;

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/studioExpenses.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/profitAllocation.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

const pools = [
  { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", status: "ACTIVE" },
  { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", status: "ACTIVE" },
];

const expenseFlows = [
  {
    id: 51, flow_no: "CF-001", pool_id: 1, occurred_on: "2026-10-20", category: "房租", direction: "OUT", amount: "3000.00", source: "OTHER", source_type: "MANUAL", is_reversed: false, status: "APPROVED",
    accounting_attribute: "OPERATING_EXPENSE",
  },
  {
    id: 52, flow_no: "CF-002", pool_id: 2, occurred_on: "2026-10-21", category: "日用", direction: "OUT", amount: "100.00", source: "OTHER", source_type: "MANUAL", is_reversed: false, status: "PENDING",
    accounting_attribute: "OPERATING_EXPENSE",
  },
];

function mockOptionSets() {
  vi.mocked(optionSetsApi.get).mockImplementation(async (code: string) => {
    if (code === "BUSINESS_PERIOD") return { code, options: [{ value: "start_day", label: "16" }] } as never;
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
  mockOptionSets();
  // 明细与三项汇总一次取回；「什么算工作室收支」的口径在 backend
  // tests/v1/test_studio_cashflow_summary.py，这里只验展示。
  vi.mocked(studioExpensesApi.summary).mockResolvedValue(studioExpenseSummary(expenseFlows as never, {
    expense: "3000.00",
    net: "-3000.00",
  }));
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "管理员", is_active: true },
  ]);
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

describe("StudioExpensePanel：工作室支出", () => {
  it("翻页时加载后端对应页的流水", async () => {
    vi.mocked(studioExpensesApi.summary).mockImplementation(async (params) =>
      studioExpenseSummary([params?.offset === 10 ? expenseFlows[1] : expenseFlows[0]] as never, { count: 201, expense: "3100.00" }));
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    expect(await screen.findByText("CF-001")).toBeInTheDocument();
    await ui.click(screen.getByTitle("2"));
    expect(await screen.findByText("CF-002")).toBeInTheDocument();
    expect(vi.mocked(studioExpensesApi.summary)).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 10, offset: 10 }));
    expect(screen.queryByText("CF-001")).toBeNull();
    await ui.click(screen.getByRole("combobox", { name: "工作室支出科目" }));
    await ui.click(await screen.findByText("房租", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(vi.mocked(studioExpensesApi.summary)).toHaveBeenLastCalledWith(expect.objectContaining({ category: "房租", offset: 0 })));
    expect(await screen.findByText("CF-001")).toBeInTheDocument();
  });
  it("已冲销原流水在筛选结果中不显示编辑和删除", async () => {
    vi.mocked(studioExpensesApi.summary).mockResolvedValue(studioExpenseSummary([{ ...expenseFlows[0], source_type: "MANUAL", ledger_type: "STUDIO", is_reversed: true }] as never));
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    const row = (await screen.findByText("CF-001")).closest("tr") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "编辑" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "删除" })).toBeNull();
  });
  it("默认汇总全部资金账户且不显示资金账户筛选", async () => {
    mockOptionSets();
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });

    expect(screen.queryByRole("button", { name: /配置承载池/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /经营主池/ })).not.toBeInTheDocument();
    expect(await screen.findByText("房租")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "资金账户筛选" })).not.toBeInTheDocument();
    expect(document.querySelector(".studio-expense-shell")).toBeTruthy();
    expect(vi.mocked(studioExpensesApi.summary).mock.lastCall?.[0]).not.toHaveProperty("pool_ids");
  });

  it("记一笔按钮独立于筛选栏", async () => {
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");

    expect(screen.getByRole("button", { name: /记一笔/ })).toBeInTheDocument();
    expect(document.querySelector(".studio-expense-filters")?.querySelector("button")).toBeNull();
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

  it("金额与笔数都取服务端，不与当页明细条数相加", async () => {
    // 故意让后端汇总与两条明细（3000 + 100）对不上：卡片必须显示后端值，
    // 笔数用后端全量 count（42）而非当页 items.length（2），避免 limit 截断漏算。
    vi.mocked(studioExpensesApi.summary).mockResolvedValue(studioExpenseSummary(expenseFlows as never, {
      income: "888.88",
      expense: "777.77",
      net: "111.11",
      count: 42,
    }));
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");

    const statRow = document.querySelector(".ui-stat-row") as HTMLElement;
    const cardOf = (label: string) => within(statRow).getByText(label).closest(".ui-stat") as HTMLElement;
    expect(within(cardOf("收入")).getByText("888.88")).toBeInTheDocument();
    expect(within(cardOf("支出")).getByText("777.77")).toBeInTheDocument();
    expect(within(cardOf("净额")).getByText("111.11")).toBeInTheDocument();
    expect(within(cardOf("笔数")).getByText("42")).toBeInTheDocument();
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
    expect(screen.queryByRole("columnheader", { name: "状态" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "冲销" })).not.toBeInTheDocument();
  });

  it("工作室收支可编辑并回填原记录", async () => {
    resolveMockOnce(vi.mocked(cashflowsApi.update), { ...expenseFlows[0], amount: "3200.00" });
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");
    const row = screen.getByText("CF-001").closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: "编辑" }));
    expect(await screen.findByText("编辑工作室收支")).toBeInTheDocument();
    expect(screen.getByLabelText("金额")).toHaveValue("3000.00");
    await ui.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(vi.mocked(cashflowsApi.update)).toHaveBeenCalledWith(51, expect.objectContaining({
      amount: "3000.00",
      occurred_on: "2026-10-20",
      category: "房租",
    })));
  });

  it("工作室收支登记带默认当前操作人", async () => {
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");
    await ui.click(screen.getByRole("button", { name: /记一笔/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    expect(within(modal).getByLabelText("操作人")).toBeInTheDocument();
    expect(employeesApi.list).toHaveBeenCalled();
  });

  it("工作室收支删除需要二次确认", async () => {
    resolveMockOnce(vi.mocked(cashflowsApi.remove), undefined);
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");
    const row = screen.getByText("CF-001").closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: "删除" }));
    expect(await screen.findByText("删除工作室收支")).toBeInTheDocument();
    expect(cashflowsApi.remove).not.toHaveBeenCalled();
    await ui.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(vi.mocked(cashflowsApi.remove)).toHaveBeenCalledWith(51));
  });

  it("登记支出：提交即入账（OUT / OPERATING_EXPENSE）", async () => {
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
      accounting_attribute: "OPERATING_EXPENSE",
      category: "房租",
      amount: "3000.00",
    });
  });

  it("流水列表拉取失败时禁用记一笔入口并展示错误重试", async () => {
    mockOptionSets();
    vi.mocked(studioExpensesApi.summary).mockRejectedValue(new Error("流水读取失败"));
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    const recordBtn = await screen.findByRole("button", { name: /记一笔/ });
    await waitFor(() => expect(recordBtn).toBeDisabled());
    expect(screen.getByText(/流水读取失败/)).toBeInTheDocument();
  });

  it("登记收入：IN / SELF_REVENUE，同样自动入账", async () => {
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
      accounting_attribute: "SELF_REVENUE",
      category: "货款",
      amount: "800.00",
    });
  });

  it("旧筛选请求后到不覆盖新筛选结果（请求竞态保护）", async () => {
    // 第一次（全部科目）请求卡住，第二次（切到「房租」）立即返回新数据；
    // 随后 resolve 第一次旧请求——若没有序号保护，旧数据会覆盖新数据。
    type SummaryResponse = Awaited<ReturnType<typeof studioExpensesApi.summary>>;
    let resolveFirst!: (value: SummaryResponse) => void;
    const first = new Promise<SummaryResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const freshFlows = [{ ...expenseFlows[0], id: 99, flow_no: "CF-NEW", category: "新科目的流水" }];
    vi.mocked(studioExpensesApi.summary)
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(
        studioExpenseSummary(freshFlows as never, { expense: "1.00", net: "-1.00", count: 1 }),
      );
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });

    // 等第二次请求（切科目）完成，显示新数据。
    await ui.click(screen.getByRole("combobox", { name: "工作室支出科目" }));
    await ui.click(await screen.findByTitle("房租"));
    await screen.findByText("新科目的流水");

    // 旧请求此时才返回：不得覆盖新筛选结果。
    resolveFirst(studioExpenseSummary(expenseFlows as never, { expense: "3000.00" }));
    await waitFor(() => expect(screen.getByText("新科目的流水")).toBeInTheDocument());
    // 旧数据的两行不应出现——若旧响应覆盖了新结果，这里就会失败。
    expect(document.querySelector('tr[data-row-key="51"]')).toBeNull();
    expect(document.querySelector('tr[data-row-key="52"]')).toBeNull();
  });

});
