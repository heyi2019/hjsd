import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountExecutionDetail } from "../shared/api/catalog";
import { renderApp } from "../test/render";
import { InventoryPanel } from "./InventoryPanel";
import { buildInventoryCsv } from "./inventory-export";

const accountsList = vi.fn();
const accountsExecutionDetail = vi.fn();
const accountsUpdateProfile = vi.fn();
const ordersCreate = vi.fn();
const ordersPostEvent = vi.fn();
const customersList = vi.fn();
const poolsList = vi.fn();
const counterpartiesList = vi.fn();
const rebatesCreate = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  accountsApi: {
    list: (...a: unknown[]) => accountsList(...a),
    executionDetail: (...a: unknown[]) => accountsExecutionDetail(...a),
    updateProfile: (...a: unknown[]) => accountsUpdateProfile(...a),
  },
  ordersApi: {
    create: (...a: unknown[]) => ordersCreate(...a),
    postEvent: (...a: unknown[]) => ordersPostEvent(...a),
  },
  customersApi: { list: (...a: unknown[]) => customersList(...a) },
  poolsApi: { list: (...a: unknown[]) => poolsList(...a) },
  counterpartiesApi: { list: (...a: unknown[]) => counterpartiesList(...a) },
  rebatesApi: { create: (...a: unknown[]) => rebatesCreate(...a) },
}));

const accounts = [
  { id: 1, inventory_no: "ACC0001", source_order_no: "HS-2026-0001", game_account: "acc-1", platform: "A平台", status: "IN_STOCK", inventory_type: "RECOVERY", cost_amount: "100.00", buy_date: "2026-10-01", created_by: "admin", created_at: "2026-10-01T09:30:00", account_description: "高段位账号", account_images: ["data:image/png;base64,image-1", "data:image/png;base64,image-2"] },
  { id: 2, inventory_no: "ACC0002", source_order_no: "TH-2026-0002", game_account: "acc-2", platform: "B平台", status: "SOLD", inventory_type: "PICKUP", cost_amount: "200.00", buy_date: "2026-10-02", created_by: "admin", created_at: "2026-10-02T09:30:00" },
];

beforeEach(() => {
  vi.clearAllMocks();
  accountsList.mockResolvedValue(accounts);
  ordersCreate.mockResolvedValue({ id: 21 });
  ordersPostEvent.mockResolvedValue({});
  customersList.mockResolvedValue([{ id: 7, display_name: "买家A", status: "ACTIVE" }]);
  poolsList.mockResolvedValue([{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }]);
  counterpartiesList.mockResolvedValue([]);
  rebatesCreate.mockResolvedValue({ id: 31 });
  accountsExecutionDetail.mockResolvedValue({
    account: accounts[0],
    orders: [{
      order_id: 21,
      order_no: "HS0001",
      order_type: "HS",
      trade_date: "2026-10-15",
      created_at: "2026-10-15T10:19:00",
      status: "ACTIVE",
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
        cashflow: { flow_no: "CF0001", pool_name: "利润池", occurred_on: "2026-10-15", direction: "OUT", nature: "BUSINESS_OUT", category: "BUY", amount: "100.00" },
      }, {
        id: 33,
        event_no: "EV0003",
        event_type: "CANCEL",
        amount: "0.00",
        occurred_on: "2026-10-17",
        occurred_at: "2026-10-17T11:35:00",
        portion: "GROSS",
        is_posted: true,
        operator: "admin",
      }],
      rebates: [{
        id: 41,
        rebate_no: "HS0001-RB01",
        rebate_type: "BUY",
        channel: "买号返点",
        rate: "5.00",
        base_amount: "1000.00",
        status: "OPEN",
        collected_on: "2026-10-17",
        collected_at: "2026-10-17T12:30:00",
      }],
    }, {
      order_id: 22,
      order_no: "DG0001",
      order_type: "DG",
      trade_date: "2026-10-12",
      created_at: "2026-10-12T09:10:00",
      status: "ACTIVE",
      counterparties: [{ id: 11, display_name: "寄售平台A", role: "PLATFORM" }],
      events: [],
    }, {
      order_id: 23,
      order_no: "HS0002",
      order_type: "HS",
      trade_date: "2026-10-16",
      created_at: "2026-10-16T16:44:00",
      status: "ACTIVE",
      events: [{
        id: 34,
        event_no: "EV0004",
        event_type: "SELL",
        amount: "350.00",
        occurred_on: "2026-10-16",
        occurred_at: "2026-10-16T16:45:00",
        portion: "PROFIT",
        is_posted: true,
        operator: "admin",
        cashflow: { flow_no: "CF0002", pool_name: "利润池", occurred_on: "2026-10-16", direction: "IN", nature: "BUSINESS_IN", category: "SELL", amount: "350.00" },
      }],
    }],
  });
  accountsUpdateProfile.mockResolvedValue(accounts[0]);
});

describe("InventoryPanel：账号台账", () => {
  it("提供库存导出入口，并按当前库存字段生成 CSV", async () => {
    expect(buildInventoryCsv(accounts)).toContain(
      "订单号,业务,类型,产品,账号标识,平台,成本,库存状态",
    );
    expect(buildInventoryCsv(accounts)).toContain(
      "HS-2026-0001,,回收,,acc-1,A平台,100.00,在库",
    );

    renderApp(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByRole("button", { name: "导出" })).toBeInTheDocument();
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
    renderApp(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByText("订单号")).toBeInTheDocument();
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
    accountsList.mockResolvedValueOnce([
      { ...accounts[0], id: 11, game_account: "green-account", buy_date: daysAgo(6) },
      { ...accounts[0], id: 12, game_account: "yellow-account", buy_date: daysAgo(14) },
      { ...accounts[0], id: 13, game_account: "red-account", buy_date: daysAgo(31) },
      { ...accounts[1], id: 14, game_account: "sold-account", buy_date: daysAgo(31) },
    ]);

    renderApp(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByText("green-account")).toBeInTheDocument();
    expect(screen.getByText("6天")).toHaveClass("ant-tag-green");
    expect(screen.getByText("14天")).toHaveClass("ant-tag-orange");
    expect(screen.getByText("31天")).toHaveClass("ant-tag-red");
    expect(screen.getAllByText("31天")).toHaveLength(1);
  });

  it("回收账号售出后描述与图片入口置灰不可点", async () => {
    accountsList.mockResolvedValueOnce([{ ...accounts[0], id: 33, status: "SOLD" }]);
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    expect(screen.getByRole("button", { name: "寄售" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下架" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "编辑" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "账号描述" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "账号图片" })).toBeDisabled();
  });

  it("库存操作区编辑可保存账号主资料与明细资料", async () => {
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(await screen.findByText("编辑账号资料")).toBeInTheDocument();
    await userEvent.clear(screen.getByPlaceholderText("账号描述"));
    await userEvent.type(screen.getByPlaceholderText("账号描述"), "已核验账号");
    await userEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(accountsUpdateProfile).toHaveBeenCalledWith(1, expect.objectContaining({
      account_description: "已核验账号",
      account_images: expect.any(Array),
      game_account: "acc-1",
    })));
  });

  it("统计卡：在库/分期中为计数，占用成本为金额（只统计在库+分期中）", async () => {
    renderApp(<InventoryPanel />, { user: "admin" });
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
    accountsList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<InventoryPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("自营在库账号可以售出并登记 HS 售出事件", async () => {
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    const sellButton = screen.getAllByRole("button", { name: "售出" }).find((button) => !(button as HTMLButtonElement).disabled);
    expect(sellButton).toBeDefined();
    await userEvent.click(sellButton as HTMLElement);
    expect(await screen.findByText("售出账号")).toBeInTheDocument();

    const modal = screen.getByText("售出账号").closest(".ant-modal-content") as HTMLElement;
    await userEvent.click(modal.querySelectorAll(".ant-select-selector")[0] as Element);
    await userEvent.click(await screen.findByText("买家A"));
    await userEvent.type(screen.getByPlaceholderText("请输入金额"), "350");
    await userEvent.click(modal.querySelectorAll(".ant-select-selector")[1] as Element);
    const poolOption = await screen.findByText(/利润池（HJ_PROFIT）/);
    await userEvent.click(poolOption);
    await userEvent.click(screen.getByRole("button", { name: /确认售出/ }));

    await waitFor(() => expect(ordersCreate).toHaveBeenCalled());
    expect(ordersCreate.mock.calls[0][0]).toMatchObject({
      order_type: "HS",
      account_id: 1,
      customer_roles: [{ customer_id: 7, role: "BUYER" }],
    });
    expect(ordersPostEvent).toHaveBeenCalledWith(21, expect.objectContaining({
      event_type: "SELL",
      amount: "350",
      pool_id: 3,
      portion: "PROFIT",
    }));
  });

  it("代挂账号售出按货源类型生成 DG 订单", async () => {
    accountsList.mockResolvedValueOnce([
      { id: 5, inventory_no: "ACC0005", game_account: "acc-5", platform: "A平台", status: "IN_STOCK", cost_amount: "50.00", inventory_type: "CONSIGNMENT" },
    ]);
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-5");
    await userEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出账号")).toBeInTheDocument();
    const modal = screen.getByText("售出账号").closest(".ant-modal-content") as HTMLElement;
    await userEvent.click(modal.querySelectorAll(".ant-select-selector")[0] as Element);
    await userEvent.click(await screen.findByText("买家A"));
    await userEvent.type(screen.getByPlaceholderText("请输入金额"), "200");
    await userEvent.click(modal.querySelectorAll(".ant-select-selector")[1] as Element);
    await userEvent.click(await screen.findByText(/利润池（HJ_PROFIT）/));
    await userEvent.click(screen.getByRole("button", { name: /确认售出/ }));
    await waitFor(() => expect(ordersCreate).toHaveBeenCalled());
    expect(ordersCreate.mock.calls[0][0]).toMatchObject({
      order_type: "DG",
      account_id: 5,
      customer_roles: [{ customer_id: 7, role: "BUYER" }],
    });
    expect(ordersPostEvent).toHaveBeenCalledWith(21, expect.objectContaining({
      event_type: "SELL",
      amount: "200",
      pool_id: 3,
      portion: "PROFIT",
    }));
  });

  it("寄售可以勾选寄售平台并登记 DG 业务", async () => {
    counterpartiesList.mockResolvedValueOnce([
      { id: 11, counterparty_no: "CP0011", display_name: "寄售平台A", type: "PLATFORM", status: "ACTIVE" },
      { id: 12, counterparty_no: "CP0012", display_name: "寄售平台B", type: "PLATFORM", status: "ACTIVE" },
    ]);
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await userEvent.click(screen.getAllByRole("button", { name: "寄售" })[0]);
    expect(await screen.findByText("登记寄售")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("寄售平台A"));
    await userEvent.click(screen.getByRole("button", { name: "确认寄售" }));

    await waitFor(() => expect(ordersCreate).toHaveBeenCalled());
    expect(ordersCreate.mock.calls[0][0]).toMatchObject({
      order_type: "DG",
      account_id: 1,
      counterparty_roles: [{ counterparty_id: 11, role: "PLATFORM" }],
    });
  });

  it("返点按买入与售出订单区分类型并登记", async () => {
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await userEvent.click(screen.getAllByRole("button", { name: "返点" })[0]);
    expect(await screen.findByText("登记返点")).toBeInTheDocument();
    expect(screen.getByLabelText("买号返点（对应回收）")).toBeChecked();
    expect(screen.getByLabelText("卖号返点（对应售出）")).toBeEnabled();
    await userEvent.click(screen.getByLabelText("卖号返点（对应售出）"));
    await userEvent.click(screen.getByRole("button", { name: "确认登记" }));

    await waitFor(() => expect(rebatesCreate).toHaveBeenCalled());
    expect(rebatesCreate.mock.calls[0][0]).toMatchObject({
      source_order_id: 23,
      rebate_type: "SELL",
      base_amount: "350.00",
      channel: "卖号返点",
    });
  });

  it("回收账号未售出时不显示卖号返点", async () => {
    accountsExecutionDetail.mockResolvedValueOnce({
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
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await userEvent.click(screen.getAllByRole("button", { name: "返点" })[0]);
    expect(await screen.findByText("登记返点")).toBeInTheDocument();
    expect(screen.getByLabelText("买号返点（对应回收）")).toBeEnabled();
    expect(screen.getByLabelText("卖号返点（对应售出）")).toBeDisabled();
  });

  it("无数据时显示「暂无账号」", async () => {
    accountsList.mockResolvedValueOnce([]);
    renderApp(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByText("暂无账号")).toBeInTheDocument();
  });

  it("展开库存订单可以查询完整执行明细与资金流水", async () => {
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await userEvent.click(document.querySelector(".ant-table-row-expand-icon") as Element);
    expect(await screen.findByText("执行明细")).toBeInTheDocument();
    const detailPanel = document.querySelector(".inventory-detail") as HTMLElement;
    const accountSummary = detailPanel.querySelector(".ant-descriptions") as HTMLElement;
    expect(within(accountSummary).getByText("库存编号")).toBeInTheDocument();
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
    expect(within(executionTable).getByRole("columnheader", { name: "动作" })).toBeInTheDocument();
    expect(within(executionTable).getByRole("columnheader", { name: "动作时间" })).toBeInTheDocument();
    expect(within(executionTable).getByRole("columnheader", { name: "金额" })).toBeInTheDocument();
    expect(within(executionTable).getByRole("columnheader", { name: "操作人" })).toBeInTheDocument();
    expect(within(executionTable).getByRole("columnheader", { name: "备注" })).toBeInTheDocument();
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
    expect(within(financePanel).getByRole("columnheader", { name: "类型" })).toBeInTheDocument();
    expect(within(financePanel).getByRole("columnheader", { name: "订单号" })).toBeInTheDocument();
    expect(within(financePanel).getByRole("columnheader", { name: "资金编号" })).toBeInTheDocument();
    expect(within(financePanel).getByRole("columnheader", { name: "方向" })).toBeInTheDocument();
    expect(within(financePanel).getByRole("columnheader", { name: "金额" })).toBeInTheDocument();
    expect(within(financePanel).getByRole("columnheader", { name: "比例" })).toBeInTheDocument();
    expect(within(financePanel).getByRole("columnheader", { name: "时间" })).toBeInTheDocument();
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
    expect(accountsExecutionDetail).toHaveBeenCalledWith(1);
    await userEvent.click(document.querySelector(".ant-table-row-expand-icon") as Element);
  });
});

describe("InventoryPanel：职责边界", () => {
  it("库存中心不提供新增账号入口", async () => {
    renderApp(<InventoryPanel />, { user: "viewer" });
    await screen.findByText("acc-1");
    expect(screen.queryByText("新增账号")).toBeNull();
    expect(screen.queryByRole("button", { name: /建\s*档/ })).toBeNull();
  });
});

describe("InventoryPanel：状态筛选", () => {
  it("按状态筛选时把 status 传给后端，而非前端过滤", async () => {
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-1");
    await userEvent.click(document.querySelector(".ant-select-selector") as Element);
    const dropdowns = document.querySelectorAll(".ant-select-dropdown");
    const option = await waitFor(() => {
      const found = [...(dropdowns[dropdowns.length - 1] as HTMLElement).querySelectorAll(
        ".ant-select-item-option",
      )].find((o) => /在库/.test(o.getAttribute("title") ?? o.textContent ?? ""));
      if (!found) throw new Error("option not ready");
      return found as Element;
    });
    await userEvent.click(option);
    await waitFor(() =>
      expect(accountsList.mock.calls.some((c) => (c[0] as { status?: string })?.status === "IN_STOCK")).toBe(
        true,
      ),
    );

    await userEvent.click(document.querySelector(".ant-select-selector") as Element);
    const voidOption = await waitFor(() => {
      const found = [...(document.querySelectorAll(".ant-select-dropdown")[0] as HTMLElement).querySelectorAll(
        ".ant-select-item-option",
      )].find((o) => /下架/.test(o.getAttribute("title") ?? o.textContent ?? ""));
      if (!found) throw new Error("下架选项未准备好");
      return found as Element;
    });
    await userEvent.click(voidOption);
    await waitFor(() =>
      expect(accountsList.mock.calls.some((c) => (c[0] as { status?: string })?.status === "VOID")).toBe(true),
    );
  });
});
