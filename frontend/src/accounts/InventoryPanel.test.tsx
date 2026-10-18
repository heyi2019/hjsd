import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountExecutionDetail } from "../shared/api/catalog";
import * as catalog from "../shared/api/catalog";
import { renderLight } from "../test/render";
import { InventoryPanel } from "./InventoryPanel";
import {
  accounts,
  setupInventoryPanelMocks,
} from "./InventoryPanel.test.fixtures";
import { buildInventoryCsv } from "./inventory-export";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("../shared/api/catalog");

setupInventoryPanelMocks();

describe("InventoryPanel：账号台账", () => {
  it("账号台账启用横向滚动以访问右侧操作列", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByRole("columnheader", { name: "订单号" });

    expect(document.querySelector(".ui-datatable .ant-table-content")).toHaveStyle({
      overflowX: "auto",
    });
  });

  it("提供库存导出入口，并按当前库存字段生成 CSV", async () => {
    expect(buildInventoryCsv(accounts)).toContain(
      "订单号,业务,类型,产品,账号标识,平台,成本,库存状态",
    );
    expect(buildInventoryCsv(accounts)).toContain(
      "HS-2026-0001,,回收,,acc-1,A平台,100.00,在库",
    );

    renderLight(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByRole("button", { name: "导出" })).toBeInTheDocument();
    expect(screen.getByText("提号")).toBeInTheDocument();
    for (const label of ["售出", "寄售", "下架", "返点", "账号描述", "账号图片"]) {
      expect(screen.getAllByRole("button", { name: label }).length).toBeGreaterThan(0);
    }
    expect(screen.queryByRole("button", { name: "查看明细" })).toBeNull();
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
    expect(csv).toContain("账号密码,渠道 / 区服,绑定手机号,有无二次,账号描述,账号图片,备注");
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

  it("渲染账号编号、标识与状态标签", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByRole("columnheader", { name: "订单号" })).toBeInTheDocument();
    expect(await screen.findByText("HS-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("TH-2026-0002")).toBeInTheDocument();
    expect(screen.getAllByText("在库").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("已售").length).toBeGreaterThanOrEqual(1);
  });

  it("按未售出时长显示绿色、黄色和红色提醒", async () => {
    const daysAgo = (days: number) => {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - days);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    };
    vi.mocked(catalog.accountsApi.list).mockResolvedValueOnce([
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

  it("回收账号售出后描述与图片入口置灰不可点", async () => {
    vi.mocked(catalog.accountsApi.list).mockResolvedValueOnce([{ ...accounts[0], id: 33, status: "SOLD" }]);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    expect(screen.getByRole("button", { name: "寄售" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下架" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "编辑" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "账号描述" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "账号图片" })).toBeDisabled();
  });

  it("统计卡：在库/分期中为计数，占用成本为金额（只统计在库+分期中）", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("在库 / 分期中");
    const occupied = screen.getByText("在库 / 分期中").closest(".ui-stat");
    expect(occupied?.textContent).toContain("1");
    const cost = screen.getByText("占用成本合计").closest(".ui-stat");
    expect(cost?.textContent).toContain("100.00"); // 只算 IN_STOCK 的 100，SOLD 的 200 不计
    // 「已售」同时是统计卡 label 与状态标签 → 只在统计卡容器里找
    const sold = screen
      .getAllByText("已售")
      .map((el) => el.closest(".ui-stat"))
      .find(Boolean);
    expect(sold?.textContent).toContain("1");
  });

  it("后端不可达 → 错误条落地", async () => {
    vi.mocked(catalog.accountsApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<InventoryPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("回收账号未售出时不显示卖号返点", async () => {
    vi.mocked(catalog.accountsApi.executionDetail).mockResolvedValueOnce({
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
    expect(screen.getByLabelText("买号返点（对应回收）")).toBeEnabled();
    expect(screen.getByLabelText("卖号返点（对应售出）")).toBeDisabled();
  });

  it("无数据时显示「暂无账号」", async () => {
    vi.mocked(catalog.accountsApi.list).mockResolvedValueOnce([]);
    renderLight(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByText("暂无账号")).toBeInTheDocument();
  });

  it("展开库存订单可以查询完整执行明细与资金流水", async () => {
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    fireEvent.click(document.querySelector(".ant-table-row-expand-icon") as Element);
    expect(await screen.findByText("执行明细")).toBeInTheDocument();
    const detailPanel = document.querySelector(".inventory-detail") as HTMLElement;
    const accountSummary = detailPanel.querySelector(".ant-descriptions") as HTMLElement;
    expect(within(accountSummary).getByText("建档操作人")).toBeInTheDocument();
    expect(within(accountSummary).queryByText("业务", { exact: true })).toBeNull();
    expect(within(accountSummary).queryByText("类型", { exact: true })).toBeNull();
    expect(within(accountSummary).queryByText("产品", { exact: true })).toBeNull();
    expect(within(accountSummary).queryByText("平台", { exact: true })).toBeNull();
    expect(within(accountSummary).queryByText("成本", { exact: true })).toBeNull();
    expect(within(accountSummary).getByText("登记时间")).toBeInTheDocument();
    expect(within(accountSummary).getByText("出售时间")).toBeInTheDocument();
    expect(within(accountSummary).getByText("下架时间")).toBeInTheDocument();
    expect(within(accountSummary).getByText("寄售时间")).toBeInTheDocument();
    expect(within(accountSummary).getByText("寄售平台")).toBeInTheDocument();
    expect(within(accountSummary).getByText("账号描述")).toBeInTheDocument();
    expect(within(accountSummary).getByText("高段位账号")).toBeInTheDocument();
    expect(within(accountSummary).getByText("账号图片")).toBeInTheDocument();
    expect(within(accountSummary).getAllByRole("img", { name: /账号图片/ })).toHaveLength(2);
    expect(within(accountSummary).queryByText("订单时间", { exact: true })).toBeNull();
    expect(within(accountSummary).getByText("2026-10-15 10:19")).toBeInTheDocument();
    expect(within(accountSummary).queryByText("2026-10-01 09:30", { exact: true })).toBeNull();
    expect(within(accountSummary).getByText("2026-10-16 16:45")).toBeInTheDocument();
    expect(within(accountSummary).getByText("2026-10-17 11:35")).toBeInTheDocument();
    expect(within(accountSummary).getByText("2026-10-12 09:10")).toBeInTheDocument();
    expect(within(accountSummary).getByText("寄售平台A")).toBeInTheDocument();
    expect(within(detailPanel).queryByText("发生日期", { exact: true })).toBeNull();
    expect(within(detailPanel).getAllByText("动作时间").length).toBeGreaterThan(0);
    const executionTable = detailPanel.querySelector(".inventory-execution-table") as HTMLElement;
    const executionHeaders = within(executionTable).getAllByRole("columnheader");
    for (const name of ["动作", "动作时间", "金额", "操作人", "备注"]) {
      const header = executionHeaders.find((item) => item.textContent?.trim() === name);
      expect(header).toHaveAccessibleName(name);
    }
    expect(executionTable.querySelectorAll("tbody tr.ant-table-row")).toHaveLength(3);
    expect(within(executionTable).getAllByText("admin").length).toBeGreaterThan(0);
    expect(executionTable.querySelector(".ant-pagination")).toBeNull();
    expect(within(detailPanel).getByText("2026-10-15 10:20")).toBeInTheDocument();
    expect(within(detailPanel).getAllByText("2026-10-17 11:35").length).toBe(2);
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
    for (const name of ["类型", "订单号", "资金编号", "方向", "金额", "比例", "时间"]) {
      const header = financeHeaders.find((item) => item.textContent?.trim() === name);
      expect(header).toHaveAccessibleName(name);
    }
    expect(within(financeSummary).getByText("100.00")).toBeInTheDocument();
    expect(within(financeSummary).getByText("350.00")).toBeInTheDocument();
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
    expect((await screen.findAllByText("HS0001")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/CF0001/).length).toBeGreaterThan(0);
    expect(vi.mocked(catalog.accountsApi.executionDetail)).toHaveBeenCalledWith(1);
    fireEvent.click(document.querySelector(".ant-table-row-expand-icon") as Element);
  });
});
