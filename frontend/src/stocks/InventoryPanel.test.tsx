import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountExecutionDetail } from "../shared/api/catalog";
import * as catalog from "../shared/api/catalog";
import { renderLight } from "../test/render";
import { InventoryPanel } from "./InventoryPanel";
import {
  accounts,
  stockNoAccounts,
  setupInventoryPanelMocks,
} from "./InventoryPanel.test.fixtures";
import { buildInventoryCsv } from "./inventory-export";
import { resolveMockOnce } from "../test/mock-api";
import { refreshListColumns } from "../shared/lib/listColumns";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("../shared/api/catalog");

setupInventoryPanelMocks();

describe("InventoryPanel：账号台账", () => {
  it("筛选控件放在台账内容区内并与上边缘保持间距", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });

    const search = await screen.findByPlaceholderText("搜索游戏账号/产品 / 游戏/产品类型 / 平台");
    const filters = search.closest(".inventory-filters");
    expect(filters).toBeInTheDocument();
    expect(filters).toHaveClass("ui-filter-bar");
    expect(filters).toHaveClass("ui-filter-bar--spaced");
    expect(search.closest(".ant-input-affix-wrapper")).toHaveClass("ui-ledger-search");
    expect(screen.queryByText("账号台账")).not.toBeInTheDocument();
  });

  it("筛选栏沿用订单台账的分组布局", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });

    await screen.findByPlaceholderText("搜索游戏账号/产品 / 游戏/产品类型 / 平台");
    expect(screen.getByText("类型筛选")).toBeInTheDocument();
    expect(screen.getByText("业务筛选")).toBeInTheDocument();
    expect(screen.queryByText("增值服务筛选")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "增值服务筛选" })).not.toBeInTheDocument();
    expect(screen.getByText("排序")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /导出/ })).toHaveTextContent("导出");
    expect(screen.queryByRole("button", { name: /导出 CSV/ })).toBeNull();
    const filterBar = screen.getByPlaceholderText("搜索游戏账号/产品 / 游戏/产品类型 / 平台").closest(".ui-filter-bar")!;
    const buttons = filterBar.querySelectorAll("button");
    expect(buttons[buttons.length - 1]).toHaveTextContent("导出");
  });

  it("搜索框右侧提供库存日期区间筛选", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });

    const search = await screen.findByPlaceholderText("搜索游戏账号/产品 / 游戏/产品类型 / 平台");
    const startDate = screen.getByPlaceholderText("开始日期");
    expect(search.compareDocumentPosition(startDate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("提供游戏类型下拉筛选库存账号", async () => {
    vi.mocked(catalog.stocksApi.list).mockResolvedValueOnce([
      { ...accounts[0], game_type: "原神" },
      { ...accounts[0], id: 3, game_account: "acc-3", game_type: "王者荣耀" },
    ]);
    renderLight(<InventoryPanel />, { user: "admin" });

    const gameTypeFilter = await screen.findByRole("combobox", { name: "游戏类型筛选" });
    await ui.click(gameTypeFilter);
    const gameTypeOption = (await screen.findAllByText("王者荣耀")).find((element) => element.classList.contains("ant-select-item-option-content"));
    expect(gameTypeOption).toBeDefined();
    await ui.click(gameTypeOption!);

    await waitFor(() => expect(screen.queryByText("acc-1")).toBeNull());
    expect(screen.getByText("acc-3")).toBeInTheDocument();
  });

  it("库存中心不展示已移除的增值服务和平台字段", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByRole("columnheader", { name: "库存编号" });

    expect(screen.queryByRole("columnheader", { name: "增值服务" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "平台" })).toBeNull();
    expect(screen.queryByText("增值服务")).toBeNull();
    expect(screen.queryByText("平台")).toBeNull();
  });

  it("库存中心展示入库时间和入库负责人", async () => {
    vi.mocked(catalog.stocksApi.list).mockResolvedValueOnce([{
      ...accounts[0],
      inventory_entry_at: "2026-10-01T09:30:00",
      created_by: "admin",
    }]);
    renderLight(<InventoryPanel />, { user: "admin" });

    expect(await screen.findByRole("columnheader", { name: "入库时间" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "入库负责人" })).toBeInTheDocument();
    const row = screen.getAllByRole("row").find((item) => within(item).queryByText("acc-1") !== null)!;
    expect(within(row).getByText("2026-10-01 09:30")).toBeInTheDocument();
    expect(within(row).getByText("admin")).toBeInTheDocument();
  });

  it("建单后刷新库存并把新账号放在第一页", async () => {
    const { rerender } = renderLight(<InventoryPanel refreshKey={0} />, { user: "admin" });
    await screen.findByText("acc-1");
    const newer = { ...accounts[0], id: 99, game_account: "new-account", source_order_no: "HS-NEW" };
    vi.mocked(catalog.stocksApi.list).mockResolvedValue([...accounts, newer]);
    rerender(<InventoryPanel refreshKey={1} />);
    await screen.findByText("new-account");
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("new-account")).toBeInTheDocument();
  });
  it("账号台账启用横向滚动以访问右侧操作列", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByRole("columnheader", { name: "订单号" });

    expect(document.querySelector(".ui-datatable .ant-table-content")).toHaveStyle({
      overflowX: "auto",
    });
  });

  it("提供库存导出入口，并按当前库存字段生成 CSV", async () => {
    expect(buildInventoryCsv(accounts)).toContain(
      "订单号,业务,类型,游戏/产品类型,营地账号,库存编号,平台,成本,库存状态",
    );
    expect(buildInventoryCsv(accounts)).toContain(
      "HS-2026-0001,,回收,,,KU_00001,A平台,100.00,在库",
    );

    renderLight(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByRole("button", { name: "导出" })).toBeInTheDocument();
    for (const label of ["售出", "寄售", "返点", "编辑", "更多"]) {
      expect(screen.getAllByRole("button", { name: label }).length).toBeGreaterThan(0);
    }
    expect(screen.queryByRole("button", { name: "下架" })).toBeNull();
    await ui.click(screen.getAllByRole("button", { name: "更多" })[0]);
    // 术语统一后「取消交易」改名「取消」，在库账号（acc-1）可从更多菜单取消。
    expect(screen.getByRole("menuitem", { name: "取消" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "下架" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "平台下架" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "系统下架" })).toBeNull();
    expect(document.querySelector(".inventory-more-menu")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看明细" })).toBeNull();
  });

  it("更多菜单收纳下架、取消、描述和作图", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");

    const stockRow = screen.getAllByRole("row").find((item) => within(item).queryByText("acc-1") !== null)!;
    await ui.click(within(stockRow).getByRole("button", { name: "更多" }));

    for (const label of ["描述", "作图"]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
  });

  it("将取消放进更多菜单，不在行内单独展示", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");

    const stockRow = screen.getAllByRole("row").find((item) => within(item).queryByText("acc-1") !== null)!;
    expect(within(stockRow).queryByRole("button", { name: "取消" })).toBeNull();

    await ui.click(within(stockRow).getByRole("button", { name: "更多" }));
    expect(screen.getByRole("menuitem", { name: "取消" })).toBeInTheDocument();
  });

  it("系统下架只对代挂账号开放，平台下架对在库账号开放", async () => {
    vi.mocked(catalog.stocksApi.list).mockResolvedValue([stockNoAccounts[2], accounts[0]]);
    renderLight(<InventoryPanel />, { user: "admin" });
    const row = await screen.findByText("acc-3").then(() => {
      const rows = screen.getAllByRole("row");
      return rows.find((item) => within(item).queryByText("acc-3") !== null)!;
    });
    await ui.click(within(row).getByRole("button", { name: "更多" }));
    expect(await screen.findByRole("menuitem", { name: "下架" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "系统下架" })).toBeNull();
  });

  it("导出时接入库存详情字段", () => {
    const detail = {
      account: accounts[0],
      orders: [{
        order_id: 21,
        order_no: "HS0001",
        order_type: "HS",
        trade_date: "2026-10-15",
        created_at: "2026-10-15T10:19:00",
        status: "ACTIVE",
        operator: "admin",
        events: [{
          id: 31,
          event_no: "EV0001",
          event_type: "BUY",
          amount: "100.00",
          occurred_on: "2026-10-15",
          occurred_at: "2026-10-15T10:20:00",
          portion: "PRINCIPAL",
          is_posted: true,
          operator: "admin",
          note: "回收登记",
          cashflow: {
            flow_no: "CF0001",
            pool_name: "利润池",
            occurred_on: "2026-10-15",
            occurred_at: "2026-10-15T10:20:00",
            direction: "OUT",
            nature: "BUSINESS_OUT",
            category: "BUY",
            amount: "100.00",
            operator: "admin",
          },
        }],
        rebates: [],
      }],
    } as unknown as AccountExecutionDetail;

    const csv = buildInventoryCsv([accounts[0]], { 1: detail });
    expect(csv).toContain("登记时间,出售时间,下架时间,寄售时间,寄售平台");
    expect(csv).toContain("渠道 / 区服,绑定手机号,有无二次,账号描述,账号图片,备注");
    expect(csv).not.toContain("账号密码");
    expect(csv).toContain("执行明细,资金明细,支出笔数,收入笔数,总支出,总收入");
    expect(csv).toContain("EV0001 · 买号 / 2026-10-15 10:20 / 100.00 / 回收登记 / admin");
    expect(csv).toContain("买号本金 / HS0001 / CF0001");
    expect(csv).toContain("CF0001");
  });

  it("资金明细按具体资金动作命名，并同步到导出", () => {
    const detail = {
      account: accounts[0],
      orders: [{
        order_id: 21,
        order_no: "HS0001",
        order_type: "HS",
        trade_date: "2026-10-15",
        created_at: "2026-10-15T10:19:00",
        status: "ACTIVE",
        events: [
          { event_no: "EV-BUY", event_type: "BUY", amount: "100.00", occurred_on: "2026-10-15", cashflow: { flow_no: "CF-BUY", direction: "OUT", amount: "100.00" } },
          { event_no: "EV-COST", event_type: "COST", amount: "20.00", occurred_on: "2026-10-15", cashflow: { flow_no: "CF-COST", direction: "OUT", amount: "20.00" } },
          { event_no: "EV-SELL", event_type: "SELL", amount: "350.00", occurred_on: "2026-10-16", cashflow: { flow_no: "CF-SELL", direction: "IN", amount: "350.00" } },
          { event_no: "EV-PAY", event_type: "PAYMENT", amount: "100.00", occurred_on: "2026-10-17", cashflow: { flow_no: "CF-PAY", direction: "IN", amount: "100.00" } },
          { event_no: "EV-CANCEL", event_type: "CANCEL", amount: "20.00", occurred_on: "2026-10-18", cashflow: { flow_no: "CF-CANCEL", direction: "IN", amount: "20.00" } },
        ],
        cashflows: [
          { flow_no: "CF-OTHER", occurred_on: "2026-10-18", direction: "OUT", amount: "12.00" },
        ],
        rebates: [{
          id: 41,
          rebate_no: "HS0001-RB01",
          rebate_type: "BUY",
          channel: "买号返点",
          rate: "5.00",
          base_amount: "1000.00",
          status: "OPEN",
          collected_on: "2026-10-17",
        }],
      }],
    } as unknown as AccountExecutionDetail;

    const csv = buildInventoryCsv([accounts[0]], { 1: detail });
    for (const label of ["买号本金", "账号成本", "售出回款", "分期回款", "取消退款", "其他支出", "买号返点"]) {
      expect(csv).toContain(label);
    }
    expect(csv).not.toContain("订单资金");
    expect(csv).not.toContain("返点资金");
  });

  it("渲染在库账号编号、标识与状态标签", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByRole("columnheader", { name: "订单号" })).toBeInTheDocument();
    expect(await screen.findByText("HS-2026-0001")).toBeInTheDocument();
    expect(screen.getAllByText("在库").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("TH-2026-0002")).toBeNull();
  });

  it("按未售出时长显示绿色、黄色和红色提醒", async () => {
    const daysAgo = (days: number) => {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - days);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    };
    vi.mocked(catalog.stocksApi.list).mockResolvedValueOnce([
      { ...accounts[0], id: 11, game_account: "green-account", buy_date: daysAgo(6) },
      { ...accounts[0], id: 12, game_account: "yellow-account", buy_date: daysAgo(14) },
      { ...accounts[0], id: 13, game_account: "red-account", buy_date: daysAgo(31) },
      { ...accounts[1], id: 14, game_account: "sold-account", buy_date: daysAgo(31) },
    ]);

    renderLight(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByText("green-account")).toBeInTheDocument();
    expect(screen.getByText("6天")).toHaveClass("ant-tag-green");
    expect(screen.getByText("14天")).toHaveClass("ant-tag-orange");
    expect(screen.getByText("31天")).toHaveClass("ant-tag-red");
    expect(screen.getAllByText("31天")).toHaveLength(1);
  });

  it("售出账号不进入库存中心", async () => {
    vi.mocked(catalog.stocksApi.list).mockResolvedValueOnce([{ ...accounts[0], id: 33, status: "SOLD" }]);
    renderLight(<InventoryPanel />, { user: "admin" });
    await waitFor(() => expect(screen.queryByText("acc-1")).toBeNull());
    expect(screen.getByText("暂无账号")).toBeInTheDocument();
  });

  it("编辑账号时可编辑核心资料（游戏账号/产品、游戏/产品类型）", async () => {
    vi.mocked(catalog.employeesApi.list).mockResolvedValue([]);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");

    // 内联编辑：点「编辑」直接就地展开该行进入编辑态，不再弹窗。
    await ui.click(screen.getAllByRole("button", { name: "编辑" })[0]);
    expect(await screen.findByLabelText("编辑游戏账号/产品")).toBeInTheDocument();
    expect(screen.getByLabelText("编辑游戏/产品类型")).toBeInTheDocument();
    // 账号密码 / 绑定手机号在编辑态以只读描述呈现，不再提供可编辑输入。
    expect(screen.queryByLabelText("编辑账号密码")).toBeNull();
    expect(screen.queryByLabelText("编辑绑定手机号")).toBeNull();
  });

  it("库存编辑展示运营信息自定义字段", async () => {
    vi.mocked(catalog.employeesApi.list).mockResolvedValue([]);
    vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue([
      {
        id: 901,
        order_type_code: "INVEDIT",
        field_key: "consignment_note",
        label: "寄售运营备注",
        field_type: "TEXT",
        options: null,
        required: false,
        is_active: true,
        sort_order: 0,
        locked: false,
        is_custom: true,
        section: "OPERATION",
        note: null,
      },
    ]);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");

    await ui.click(screen.getAllByRole("button", { name: "编辑" })[0]);
    expect((await screen.findAllByText("运营信息")).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("寄售运营备注")).toBeInTheDocument();
  });

  it("统计卡：只统计在库账号与占用成本", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("在库账号");
    const occupied = screen.getByText("在库账号").closest(".ui-stat");
    expect(occupied?.textContent).toContain("1");
    const cost = screen.getByText("占用成本合计").closest(".ui-stat");
    expect(cost?.textContent).toContain("100.00");
    expect(screen.queryByText("已售")).toBeNull();
  });

  it("后端不可达 → 错误条落地", async () => {
    vi.mocked(catalog.stocksApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<InventoryPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("回收账号可以打开返点登记", async () => {
    resolveMockOnce(vi.mocked(catalog.stocksApi.executionDetail), {
      account: accounts[0],
      orders: [{
        order_id: 21,
        order_no: "HS0001",
        order_type: "HS",
        trade_date: "2026-10-15",
        status: "ACTIVE",
        events: [{
          id: 31,
          event_no: "EV0001",
          event_type: "BUY",
          amount: "100.00",
          occurred_on: "2026-10-15",
          portion: "PRINCIPAL",
          is_posted: true,
        }],
      }],
    });
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await ui.click(screen.getAllByRole("button", { name: "返点" })[0]);
    expect(await screen.findByText("登记返点")).toBeInTheDocument();
  });

  it("无数据时显示「暂无账号」", async () => {
    vi.mocked(catalog.stocksApi.list).mockResolvedValueOnce([]);
    renderLight(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByText("暂无账号")).toBeInTheDocument();
  });

  it("展开库存订单可以查询完整执行明细与资金流水", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    fireEvent.click(screen.getByText("acc-1").closest("tr")!.querySelector(".ant-table-row-expand-icon") as Element);
    const detailPanel = (await screen.findByText("当前运营状态")).closest(".inventory-detail") as HTMLElement;
    const accountSummary = detailPanel;
    // 新版只读详情：账号基本资料（业务 / 平台 / 成本 / 登记时间 / 出售时间 / 建档操作人）已不在面板展示，仅保留于 CSV 导出；
    // 面板按板块聚焦：运营信息含「寄售平台 / 寄售时间」与「账号补充资料（描述 / 作图）」，游戏账号信息含 ACCOUNT_PRODUCT 扩展（高段位账号）。
    expect(within(accountSummary).getByText("寄售平台 / 寄售时间")).toBeInTheDocument();
    expect(within(accountSummary).getByText("描述")).toBeInTheDocument();
    expect(within(accountSummary).getByText("高段位账号")).toBeInTheDocument();
    expect(within(accountSummary).getByText("作图")).toBeInTheDocument();
    expect(within(accountSummary).getAllByRole("img", { name: /作图/ })).toHaveLength(2);
    expect(within(accountSummary).queryByText("订单时间", { exact: true })).toBeNull();
    expect(within(accountSummary).getByText("寄售平台A / 2026-10-12 09:10")).toBeInTheDocument();
    // 回收(RECOVERY)类型的账号同样可寄售，寄售记录以 DG 单承载，与账号 inventory_type 无关。
    expect(within(accountSummary).getAllByText(/寄售平台A/).length).toBeGreaterThan(0);
    expect(within(detailPanel).queryByText("发生日期", { exact: true })).toBeNull();
    expect(within(detailPanel).getAllByText("动作时间").length).toBeGreaterThan(0);
    // 详情页执行/资金表为窄窗横向滚动（L202）定制，使用 .inventory-execution-table /
    // .inventory-finance-table 自有规则，不套用 .ui-datatable--inline 的 overflow-x: clip。
    const executionTable = detailPanel.querySelector(".inventory-execution-list .inventory-execution-table") as HTMLElement;
    const executionHeaders = within(executionTable).getAllByRole("columnheader");
    for (const name of ["动作", "平台", "动作时间", "金额", "操作人", "备注"]) {
      const header = executionHeaders.find((item) => item.textContent?.trim() === name);
      expect(header).toHaveAccessibleName(name);
    }
    expect(executionTable.querySelectorAll("tbody tr.ant-table-row")).toHaveLength(3);
    expect(within(executionTable).getAllByText("admin").length).toBeGreaterThan(0);
    expect(executionTable.querySelector(".ant-pagination")).toBeNull();
    expect(within(detailPanel).getByText("2026-10-15 10:20")).toBeInTheDocument();
    // 下架时间已收进操作明细表（CANCEL 行的动作时间），不再有独立字段，故只出现一次。
    expect(within(detailPanel).getAllByText("2026-10-17 11:35").length).toBe(1);
    const executionList = detailPanel.querySelector(".inventory-execution-list") as HTMLElement;
    expect(within(executionList).queryByText("订单号", { exact: true })).toBeNull();
    expect(within(executionList).queryByText("类型", { exact: true })).toBeNull();
    expect(within(executionList).queryByText("订单时间", { exact: true })).toBeNull();
    expect(within(executionList).queryByText("状态", { exact: true })).toBeNull();
    expect(within(executionList).queryByText("订单操作人", { exact: true })).toBeNull();
    expect(within(executionList).queryByText("流水操作人", { exact: true })).toBeNull();
    expect(within(detailPanel).getByText("资金明细")).toBeInTheDocument();
    expect(within(detailPanel).queryByText("资金流水", { exact: true })).toBeNull();
    expect(within(detailPanel).queryByText("流水时间", { exact: true })).toBeNull();
    const financePanel = detailPanel.querySelector(".inventory-finance-list") as HTMLElement;
    const financeSummary = financePanel.querySelector(".inventory-finance-summary") as HTMLElement;
    expect(within(financeSummary).getByText("支出")).toBeInTheDocument();
    expect(within(financeSummary).getByText("收入")).toBeInTheDocument();
    expect(within(financeSummary).getByText("总支出")).toBeInTheDocument();
    expect(within(financeSummary).getByText("总收入")).toBeInTheDocument();
    const financeHeaders = within(financePanel).getAllByRole("columnheader");
    for (const name of ["类型", "方向", "金额", "比例", "时间"]) {
      const header = financeHeaders.find((item) => item.textContent?.trim() === name);
      expect(header).toHaveAccessibleName(name);
    }
    expect(within(financePanel).queryByText("HS0001", { exact: true })).toBeNull();
    expect(within(financePanel).queryByText("CF0001", { exact: true })).toBeNull();
    expect(within(executionTable).queryByText("EV0001", { exact: true })).toBeNull();
    expect(within(financeSummary).getByText("100.00")).toBeInTheDocument();
    // 总收入 = IN 流水（售出回款 350）+ 返点登记额（夹具 base_amount 1000）。
    // 返点当前按 base_amount 计入收入（登记即收入）；口径争议见返点基数/费率待裁决，
    // 若口径改为「基数×费率」，此处应同步改成 400.00。
    expect(within(financeSummary).getByText("1,350.00")).toBeInTheDocument();
    const financeTable = financePanel.querySelector(".inventory-finance-table") as HTMLElement;
    expect(financeTable.querySelector(".ant-pagination")).toBeNull();
    expect(within(financeTable).getByText("100.00")).toBeInTheDocument();
    expect(within(financeTable).getByText("350.00")).toBeInTheDocument();
    expect(within(financeTable).getByText("买号本金")).toBeInTheDocument();
    expect(within(financeTable).getByText("售出回款")).toBeInTheDocument();
    expect(within(financeTable).getByText("买号返点")).toBeInTheDocument();
    expect(within(financeTable).getByText("1,000.00")).toBeInTheDocument();
    expect(within(financeTable).getByText("5.00%")).toBeInTheDocument();
    expect(within(financeTable).getByText("2026-10-17 12:30")).toBeInTheDocument();
    expect(vi.mocked(catalog.stocksApi.executionDetail)).toHaveBeenCalledWith(1);
    fireEvent.click(document.querySelector(".ant-table-row-expand-icon") as Element);
  });

  it("未售时长列受列表字段配置控制：配置隐藏后列头消失、其余列不受影响", async () => {
    // 模拟「设置→配置中心→字段配置→列表字段→库存中心」里把 inventory_age 设为隐藏。
    // 修复前该列 key 为 inventoryAge（与注册表 inventory_age 不符），隐藏/调序均不生效。
    vi.mocked(catalog.listColumnsApi.all).mockResolvedValue([
      {
        code: "INVENTORY",
        columns: [
          { key: "stock_no", is_visible: true, sort_order: 0 },
          { key: "game_type", is_visible: true, sort_order: 10 },
          { key: "game_account", is_visible: true, sort_order: 20 },
          { key: "source_order_no", is_visible: true, sort_order: 30 },
          { key: "business_mode", is_visible: true, sort_order: 40 },
          { key: "inventory_type", is_visible: true, sort_order: 50 },
          { key: "inventory_age", is_visible: false, sort_order: 60 },
          { key: "status", is_visible: true, sort_order: 70 },
          { key: "cost_amount", is_visible: true, sort_order: 80 },
          { key: "actions", is_visible: true, sort_order: 90 },
        ],
      },
    ] as unknown as catalog.ListScopeConfig[]);
    refreshListColumns();

    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByRole("columnheader", { name: "库存编号" });
    // 配置隐藏 inventory_age 后，未售时长列头应消失
    await waitFor(() =>
      expect(screen.queryByRole("columnheader", { name: "未售时长" })).toBeNull(),
    );
    // 相邻普通列仍正常显示，证明只是未售时长被控
    expect(screen.queryByRole("columnheader", { name: "平台" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "成本" })).toBeInTheDocument();
  });

  it("状态列使用列表字段注册键参与排序", async () => {
    vi.mocked(catalog.listColumnsApi.all).mockResolvedValue([
      {
        code: "INVENTORY",
        columns: [
          { key: "status", is_visible: true, sort_order: 0 },
          { key: "stock_no", is_visible: true, sort_order: 10 },
        ],
      },
    ] as unknown as catalog.ListScopeConfig[]);
    refreshListColumns();

    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByRole("columnheader", { name: "状态" });
    const headers = Array.from(document.querySelectorAll(".ant-table-thead tr:first-child th"))
      .map((header) => header.textContent?.trim())
      .filter(Boolean);
    expect(headers[0]).toBe("状态");
  });
});
