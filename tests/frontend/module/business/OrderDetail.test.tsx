import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountExecutionDetail } from "@/shared/api/types/account-execution";
import type { Account } from "@/shared/api/types/accounts";
import { groupOperationEvents, OrderDetail } from "@/business/shared/order-detail/OrderDetail";
import { buildOperationPlatformUsage, buildUnlistingOptions, createOperationPlatformOptions, OrderDetailOperationSection, resolveOperationEventContent } from "@/business/shared/order-detail/OrderDetailOperationSection";
import { OrderDetailFinanceSection } from "@/business/shared/order-detail/OrderDetailFinanceSection";
import { OrderDetailExecutionSection } from "@/business/shared/order-detail/OrderDetailExecutionSection";
import { OrderDetailMoneyInput } from "@/business/shared/order-detail/OrderDetailMoneyInput";
import { findCurrentSaleEvent } from "@/business/shared/order-detail/OrderDetailDeliverySection";
import { buildCustomerOptions, getPartySelectionDelta, groupCustomerIdsByRole, mergeCustomerSearch } from "@/business/shared/order-detail/OrderDetailPartySection";
import type { OrderDetailMeta } from "@/business/shared/order-detail/OrderDetail.shared";
import { orderFormFieldsApi, ordersApi } from "@/shared/api/orders.api";
import { customersApi, counterpartiesApi } from "@/shared/api/customers.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { optionSetList } from "@fixtures/api-responses";
import { renderApp, renderLight } from "@fixtures/render";
import { appMessage } from "@/shared/ui/appFeedback";

const account = {
  id: 1,
  game_account: "acc-1",
  inventory_type: "RECOVERY",
  status: "WAITING",
  created_by: "admin",
  created_at: "2026-10-01T09:30:00",
  account_description: "高段位账号",
  account_images: [],
  has_secondary: false,
  cost_amount: "100.00",
} as unknown as Account;

const emptyMeta: OrderDetailMeta = {
  orderNo: "-", createdBy: "-", registeredAt: "-", soldAt: "-", removedAt: "-",
  removedPlatform: "-", recoveryPlatform: "-", salePlatform: "-",
  listedPlatform: "-", listedAt: "-", listedOperator: "-",
  unlistedPlatform: "-", unlistedAt: "-", unlistedOperator: "-",
  descriptionAt: "-", descriptionOperator: "-", imagesAt: "-", imagesOperator: "-",
  password: "-", channelRegion: "-", boundPhone: "-", secondary: "-", walletRealname: "-",
  walletRealnameImages: [], accountDescription: "-", accountImages: [], secondaryImages: [],
  note: "-", orderNotes: "-", orderParties: null, orderExtras: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  // OrderDetail 编辑态会按 scope 异步加载字段配置。测试不关心配置接口本身，
  // 固定为空响应并主动等待一次微任务，避免异步清理状态落在测试 act 之外。
  vi.spyOn(orderFormFieldsApi, "list").mockResolvedValue([]);
  vi.spyOn(orderFormFieldsApi, "listSectionLabels").mockResolvedValue({});
  vi.spyOn(optionSetsApi, "list").mockResolvedValue(optionSetList());
  vi.spyOn(customersApi, "options").mockResolvedValue([]);
  vi.spyOn(counterpartiesApi, "list").mockResolvedValue([]);
});

async function settleFieldConfig() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("OrderDetail", () => {
  it("卖号交付使用后端指定的售出事件", () => {
    const order = { latest_sale_event_id: 1, events: [{ id: 1, event_type: "SELL" }, { id: 2, event_type: "SELL" }] };
    expect(findCurrentSaleEvent(order as never)?.id).toBe(1);
    expect(findCurrentSaleEvent({ ...order, latest_sale_event_id: null } as never)).toBeUndefined();
  });
  it("参与方初始选择按角色去重并保留每个角色首次出现顺序", () => {
    const customers = [
      { id: 2, role: "SELLER" }, { id: 1, role: "BUYER" }, { id: 1, role: "SELLER" },
      { id: 2, role: "SELLER" }, { id: 2, role: "BUYER" }, { id: 1, role: "BUYER" },
    ];
    expect(groupCustomerIdsByRole(customers)).toEqual({ SELLER: [2, 1], BUYER: [1, 2] });
    expect(groupCustomerIdsByRole([])).toEqual({});
  });

  it("运营编辑各行共用员工选项，员工更新后显示最新姓名", async () => {
    let reads = 0;
    const employees = Array.from({ length: 100 }, (_, index) => ({
      get id() { reads += 1; return index + 1; }, username: `user${index}`, display_name: `员工${index + 1}`, is_active: true,
    }));
    const { rerender } = renderLight(<OrderDetailOperationSection meta={emptyMeta} account={account} editing employees={employees} operatorUsername="none" />);
    await settleFieldConfig();
    reads = 0;
    rerender(<OrderDetailOperationSection meta={emptyMeta} account={account} editing employees={employees} operatorUsername="none" operationDrafts={{}} />);
    expect(reads).toBeLessThanOrEqual(200);
    rerender(<OrderDetailOperationSection meta={emptyMeta} account={account} editing operatorUsername="none"
      employees={[{ id: 101, username: "new", display_name: "最新员工", is_active: true }, { id: 102, username: "inactive", display_name: "停用员工", is_active: false }]} />);
    await userEvent.click(screen.getByRole("combobox", { name: "编辑描述操作人" }));
    expect(await screen.findByText("最新员工", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    expect(screen.getByText("停用员工", { selector: ".ant-select-item-option-content" }).closest(".ant-select-item-option")).toHaveClass("ant-select-item-option-disabled");
  });
  it("参与方选择增删保留原顺序且不重复扫描", () => {
    expect(getPartySelectionDelta([1, 1, 2], [2, 3, 3])).toEqual({ added: [3, 3], removed: [1, 1] });
    let reads = 0;
    const counted = (start: number) => new Proxy(Array.from({ length: 200 }, (_, i) => start + i), {
      get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads += 1; return Reflect.get(target, key, receiver); },
    });
    expect(getPartySelectionDelta(counted(0), counted(100)).added).toHaveLength(100);
    expect(reads).toBeLessThanOrEqual(1000);
  });
  it("平台占用检查排除当前行且线性读取已有上架", () => {
    let reads = 0;
    const listings = Array.from({ length: 200 }, (_, i) => ({ get platform() { reads += 1; return `平台${i}`; }, eventId: i }));
    const taken = buildOperationPlatformUsage(listings, { a: { operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["草稿平台"] } } });
    expect(taken("平台0", 0, "x")).toBe(false);
    expect(taken("平台0", 1, "x")).toBe(true);
    expect(taken("草稿平台", undefined, "a")).toBe(false);
    expect(taken("草稿平台", undefined, "b")).toBe(true);
    for (let i = 0; i < 200; i++) taken(`平台${i}`, i, "x");
    expect(reads).toBeLessThanOrEqual(400);
    const duplicates = buildOperationPlatformUsage([{ platform: "A", eventId: 1 }, { platform: "A", eventId: 2 }], {
      a: { operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["B"] } },
      b: { operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["B"] } },
    });
    expect(duplicates("A", 1, "x")).toBe(true);
    expect(duplicates("B", undefined, "a")).toBe(true);
  });
  it("参与方候选按首条去重并保持现有客户的显示顺序", () => {
    expect(buildCustomerOptions([{ id: 1, display_name: "原客户" }, { id: 1, display_name: "重复" }, { id: 2, display_name: "旧名" }],
      [{ id: 2, customer_no: "C2", display_name: "新名" }])).toEqual([{ value: 1, label: "原客户" }, { value: 2, label: "C2 · 新名" }]);
  });

  it("搜索结果保留已选客户，同时避免批量交叉扫描", () => {
    let reads = 0;
    const current = Array.from({ length: 200 }, (_, i) => ({ id: i, customer_no: `C${i}`, display_name: `旧${i}` }));
    const rows = Array.from({ length: 200 }, (_, i) => ({ get id() { reads += 1; return i + 100; }, customer_no: `C${i + 100}`, display_name: `新${i + 100}` }));
    const result = mergeCustomerSearch(current, rows, new Set(current.map((item) => item.id)));
    expect(result.length).toBe(300);
    expect(result[0].id).toBe(0);
    expect(result[100].id).toBe(100);
    expect(reads).toBeLessThanOrEqual(400);
  });
  it("详情编辑金额超过后端整数位数上限时在字段旁提示", () => {
    const { rerender } = renderLight(<OrderDetailMoneyInput label="金额" value="10000000000000000.00" onChange={vi.fn()} />);
    expect(screen.getByLabelText("金额")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("金额整数部分最多16位")).toBeInTheDocument();
    rerender(<OrderDetailMoneyInput label="金额" value="9999999999999999.99" onChange={vi.fn()} />);
    expect(screen.getByLabelText("金额")).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("金额整数部分最多16位")).not.toBeInTheDocument();
    rerender(<OrderDetailMoneyInput label="金额" value="00000000000000001.00" onChange={vi.fn()} />);
    expect(screen.getByLabelText("金额")).toHaveAttribute("aria-invalid", "false");
  });
  it("清空执行金额和资金明细金额时在字段旁提示", () => {
    const event = { id: 7, event_type: "BUY", amount: "100.00", cashflow: {} } as never;
    renderLight(<>
      <OrderDetailExecutionSection editing employees={[]} rows={[{ key: "event-7", orderId: 1, category: "INBOUND", action: "入库", occurredAt: "-", operator: "-", amount: "100.00", note: "-", platform: "-", event }]} eventDrafts={{ 7: { id: 7, amount: "", expected_amount: "100.00" } as never }} />
      <OrderDetailFinanceSection editing rows={[{ key: "CF7", flowNo: "CF7", type: "支出", direction: "支出", amount: "100.00", occurredAt: "-", operator: "-", poolId: 1, poolName: "账户", note: "-" } as never]} orderExtras={[]} expenseCount={1} incomeCount={0} totalExpense="100.00" totalIncome="0" financeDrafts={{ CF7: { flow_no: "CF7", amount: "", occurred_at: "", note: "" } }} />
    </>);
    expect(screen.getByLabelText("编辑执行金额 入库")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("编辑资金明细金额 CF7")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByText("请输入金额")).toHaveLength(2);
  });
  it("编辑寄售价时保留大额金额精度", () => {
    const onEventEdit = vi.fn();
    const listing = { id: 7, event_type: "OPERATE", operation_type: "CONSIGNMENT", amount: "0", occurred_at: "2026-10-01T10:00:00", form_extra: { consignment_platforms: ["平台甲"], consignment_price: "9999999999999999.99" } } as never;
    renderLight(<OrderDetailOperationSection meta={emptyMeta} account={account} editing orderType="HS" operationEvents={{ consignment: [listing] }} onEventEdit={onEventEdit} />);
    const price = screen.getByRole("spinbutton", { name: "编辑寄售价格" });
    expect(price).toHaveDisplayValue("9999999999999999.99");
    fireEvent.change(price, { target: { value: "9999999999999999.98" } });
    expect(onEventEdit).toHaveBeenCalledWith(listing, expect.objectContaining({ form_extra: expect.objectContaining({ consignment_price: "9999999999999999.98" }) }));
  });
  it("保存中暂停编辑，避免保存完成后丢失后续输入", async () => {
    const { rerender } = renderLight(<OrderDetail row={account} loading={false} editing={account} saving />);
    const channel = await screen.findByLabelText("编辑渠道区服");
    expect(channel).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    rerender(<OrderDetail row={account} loading={false} editing={account} saving={false} />);
    expect(screen.getByLabelText("编辑渠道区服")).toBeEnabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
  });

  it("运营事件分组只读取一遍并按时间倒序保留同时间先后", () => {
    let reads = 0;
    const events = Array.from({ length: 100 }, (_, index) => ({
      id: index, get event_type() { reads += 1; return "OPERATE"; },
      operation_type: index % 2 ? "UNLIST" : "CONSIGNMENT", occurred_at: index < 4 ? "2026-01-01" : "2026-02-01",
    })) as never;
    const groups = groupOperationEvents(events);
    expect(groups.consignment.slice(-2).map((event) => event.id)).toEqual([0, 2]);
    expect(groups.unlist.slice(-2).map((event) => event.id)).toEqual([1, 3]);
    expect(reads).toBeLessThanOrEqual(200);
  });

  it("下架候选保留原顺序和同编号首条匹配", () => {
    const first = { eventId: 7, platform: "甲", listedAt: "10:00" };
    const duplicate = { eventId: 7, platform: "甲", listedAt: "11:00" };
    const missing = { eventId: undefined, platform: "乙", listedAt: "12:00" };
    const result = buildUnlistingOptions([first, duplicate, missing]);
    expect(result.choices.map((item) => item.value)).toEqual(['[7,"甲"]', '[7,"甲"]']);
    expect(result.byKey.get('[7,"甲"]')).toBe(first);
    expect(result.byKey.get('[null,"乙"]')).toBe(missing);
  });

  it("运营平台候选复用词典索引并保留已选平台原有排序", () => {
    let reads = 0;
    const options = Array.from({ length: 100 }, (_, index) => ({
      get value() { reads += 1; return `平台${index}`; }, label: `名称${index}`,
    }));
    const build = createOperationPlatformOptions(options);
    const result = build(["新增甲", "新增乙", "新增甲", "__SYSTEM__"], true);
    expect(result.slice(0, 2).map((item) => item.value)).toEqual(["新增乙", "新增甲"]);
    expect(result[result.length - 1]).toEqual({ value: "__SYSTEM__", label: "本系统" });
    for (let i = 0; i < 50; i += 1) build(["新增甲"], false);
    expect(reads).toBeLessThanOrEqual(200);
  });

  it("编辑草稿重渲染时复用运营记录，详情快照变化时更新", async () => {
    let reads = 0;
    const operation = { key: "consignment", action: "上架平台", content: "平台甲", occurred_at: null, operator: "-", get event_id() { reads += 1; return null; } };
    const detail = { account, orders: [{ order_id: 1, order_no: "HS1", order_type: "HS", events: [] }],
      detail_view: { operation_rows: [operation], execution_rows: [], finance_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] },
      finance_summary: { total_expense: "0", total_income: "0" } } as unknown as AccountExecutionDetail;
    const { rerender } = renderLight(<OrderDetail row={account} detail={detail} contextOrderId={1} loading={false} editing={account} financeDrafts={{}} />);
    await settleFieldConfig();
    const initialReads = reads;
    expect(initialReads).toBeGreaterThan(0);
    rerender(<OrderDetail row={account} detail={detail} contextOrderId={1} loading={false} editing={account} financeDrafts={{ CF: { flow_no: "CF", note: "更改", occurred_at: "" } }} />);
    expect(reads).toBe(initialReads);
    const nextDetail = { ...detail, detail_view: { ...detail.detail_view, operation_rows: [{ ...operation, content: "平台乙" }] } };
    rerender(<OrderDetail row={account} detail={nextDetail} contextOrderId={1} loading={false} />);
    expect(screen.getByText("平台乙")).toBeInTheDocument();
  });
  it("新增下架行选择具体上架事件并保存关联编号", async () => {
    const onOperationEdit = vi.fn();
    const listing = { id: 7, event_type: "OPERATE", operation_type: "CONSIGNMENT", amount: "0", occurred_at: "2026-10-01T10:00:00", form_extra: { consignment_platforms: ["平台甲"], listed_at: "2026-10-01T10:00" } } as never;
    renderLight(<OrderDetailOperationSection meta={emptyMeta} account={account} editing orderType="HS" operationEvents={{ consignment: [listing] }} activeListings={[{ id: "1:7:平台甲", orderId: 1, orderNo: "HS0001", eventId: 7, platform: "平台甲", price: null, listedAt: "2026-10-01 10:00" }]} onOperationEdit={onOperationEdit} />);
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "编辑下架平台" }).closest(".ant-select-selector")!);
    fireEvent.click(await screen.findByText(/平台甲.*2026-10-01/, { selector: ".ant-select-item-option-content" }));
    expect(onOperationEdit).toHaveBeenCalledWith("unlist", expect.objectContaining({ form_extra: expect.objectContaining({ consignment_event_id: 7, consignment_platforms: ["平台甲"], platform_unlist_scope: "PLATFORM" }) }));
  });

  it("同平台多次上架时按上架时间和事件编号区分下架目标", async () => {
    const onOperationEdit = vi.fn();
    const makeListing = (id: number, time: string) => ({ id, event_type: "OPERATE", operation_type: "CONSIGNMENT", amount: "0", occurred_at: time, form_extra: { consignment_platforms: ["平台甲"], listed_at: time } }) as never;
    renderLight(<OrderDetailOperationSection meta={emptyMeta} account={account} editing orderType="HS" operationEvents={{ consignment: [makeListing(7, "2026-10-01T10:00:00"), makeListing(8, "2026-10-02T10:00:00")] }} activeListings={[{ id: "1:7:平台甲", orderId: 1, orderNo: "HS0001", eventId: 7, platform: "平台甲", price: null, listedAt: "2026-10-01 10:00" }, { id: "1:8:平台甲", orderId: 1, orderNo: "HS0001", eventId: 8, platform: "平台甲", price: null, listedAt: "2026-10-02 10:00" }]} onOperationEdit={onOperationEdit} />);
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "编辑下架平台" }).closest(".ant-select-selector")!);
    fireEvent.click(await screen.findByText(/平台甲.*2026-10-02.*事件 8/, { selector: ".ant-select-item-option-content" }));
    expect(onOperationEdit).toHaveBeenCalledWith("unlist", expect.objectContaining({ form_extra: expect.objectContaining({ consignment_event_id: 8, consignment_platforms: ["平台甲"] }) }));
  });
  it("关联上架事件的历史下架记录锁定平台但仍可编辑时间", () => {
    const unlist = { id: 9, event_type: "OPERATE", operation_type: "UNLIST", amount: "0", occurred_at: "2026-10-02T11:00:00", form_extra: { operation_type: "UNLIST", consignment_event_id: 7, consignment_platforms: ["平台甲"], platform_unlist_scope: "PLATFORM" } } as never;
    renderLight(<OrderDetailOperationSection meta={emptyMeta} account={account} editing orderType="DG" operationEvents={{ unlist: [unlist] }} />);
    expect(screen.getByRole("combobox", { name: "编辑下架平台" })).toBeDisabled();
    expect(screen.getByLabelText("编辑下架平台时间")).not.toBeDisabled();
  });
  it.each(["HS", "TH", "DG"] as const)("%s 订单详情不能新增本系统下架", async (orderType) => {
    renderLight(<OrderDetailOperationSection meta={emptyMeta} account={account} editing orderType={orderType} />);
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "编辑下架平台" }).closest(".ant-select-selector")!);
    expect(screen.queryByText("本系统", { selector: ".ant-select-item-option-content" })).toBeNull();
    if (orderType === "DG") expect(screen.getByText(/本系统下架请/)).toBeInTheDocument();
  });
  it("历史本系统下架锁定目标但仍可编辑时间", () => {
    const unlist = { id: 9, event_type: "OPERATE", operation_type: "UNLIST", amount: "0", occurred_at: "2026-10-02T11:00:00", form_extra: { operation_type: "UNLIST", platform_unlist_scope: "SYSTEM" } } as never;
    renderLight(<OrderDetailOperationSection meta={emptyMeta} account={account} editing orderType="DG" operationEvents={{ unlist: [unlist] }} />);
    expect(screen.getByRole("combobox", { name: "编辑下架平台" })).toBeDisabled();
    expect(screen.getByLabelText("编辑下架平台时间")).not.toBeDisabled();
  });
  it("多条运营记录按各自事件展示平台和寄售价", () => {
    expect(resolveOperationEventContent("consignment", "盼之 / 寄售价 ¥88.00", {
      event_type: "OPERATE",
      operation_type: "CONSIGNMENT",
      form_extra: { consignment_platforms: ["千寻"], consignment_price: 66 },
    })).toBe("千寻 / 寄售价 ¥66.00");
    expect(resolveOperationEventContent("unlist", "本系统", {
      event_type: "OPERATE",
      operation_type: "UNLIST",
      form_extra: { consignment_platforms: ["盼之"], platform_unlist_scope: "PLATFORM" },
    })).toBe("盼之");
  });

  it("运营明细中的大额寄售价保留分位", () => {
    expect(resolveOperationEventContent("consignment", "-", {
      event_type: "OPERATE",
      operation_type: "CONSIGNMENT",
      form_extra: { consignment_platforms: ["千寻"], consignment_price: "9999999999999999.99" },
    })).toBe("千寻 / 寄售价 ¥9,999,999,999,999,999.99");
  });

  it("运营明细展示平台下架原因", () => {
    const unlist = { id: 9, event_type: "OPERATE", operation_type: "UNLIST", amount: "0", occurred_at: "2026-10-02T11:00:00", reason: "平台停售", form_extra: { consignment_platforms: ["平台甲"], platform_unlist_scope: "PLATFORM" } } as never;
    renderLight(<OrderDetailOperationSection meta={emptyMeta} account={account} operationEvents={{ unlist: [unlist] }} />);
    expect(screen.getByText(/平台甲.*平台停售/)).toBeInTheDocument();
  });

  it("加载中没有明细时显示加载状态", () => {
    render(<OrderDetail row={account} loading />);
    expect(document.querySelector(".ant-spin")).toBeTruthy();
  });

  it("后端未返回或返回无效资金合计时显示不可用，真实零值仍显示零", () => {
    const detail = {
      account, orders: [],
      detail_view: { operation_rows: [], execution_rows: [], finance_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] },
      finance_summary: { total_expense: "0.00" },
    } as unknown as AccountExecutionDetail;
    const view = renderLight(<OrderDetail row={account} detail={detail} loading={false} />);
    expect(screen.getByText("总收入").parentElement).toHaveTextContent("不可用");
    expect(screen.getByText("总支出").parentElement).toHaveTextContent("0.00");
    view.rerender(<OrderDetail row={account} detail={{ ...detail, finance_summary: { ...detail.finance_summary, total_income: "32.50", total_expense: "错误" } }} loading={false} />);
    expect(screen.getByText("总收入").parentElement).toHaveTextContent("32.50");
    expect(screen.getByText("总支出").parentElement).toHaveTextContent("不可用");
  });

  it("按动作和资金明细展示操作人、方向与汇总", () => {
    const detail = {
      orders: [{
        order_id: 1,
        order_no: "HS0001",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        events: [{
          id: 1,
          event_no: "EV0001",
          event_type: "BUY",
          amount: "100.00",
          occurred_at: "2026-10-15T10:20:00",
          operator: "admin",
          note: "回收登记",
          cashflow: { flow_no: "CF0001", direction: "OUT", amount: "100.00" },
        }],
        rebates: [],
      }],
      detail_view: {
        operation_rows: [],
        execution_rows: [{ key: "buy", order_id: 1, category: "INBOUND", action: "回收入库", occurred_at: "2026-10-15T10:20:00", amount: "100.00", operator: "admin", note: "回收登记", platform: "-", event_id: 1 }],
        finance_rows: [{ key: "CF0001", flow_no: "CF0001", type: "回收成本", direction: "支出", amount: "100.00", occurred_at: "2026-10-15T10:20:00", pool_name: "经营荷包", note: "回收登记", operator: "admin", event_id: 1 }],
        lifecycle: { removed_platform: "-", recovery_platform: "-", sale_platform: "-" },
        order_notes: "-",
        parties: [],
        extras: [],
      },
      finance_summary: { cashflow_income: "0.00", rebate_income: "0.00", total_income: "0.00", total_expense: "100.00", net_amount: "-100.00" },
    } as unknown as AccountExecutionDetail;

    render(<OrderDetail row={account} detail={detail} loading={false} />);
    const panel = document.querySelector(".order-detail") as HTMLElement;
    expect(within(panel).getByText("渠道 / 区服")).toBeInTheDocument();
    // 第一部分为竖向堆叠的多个板块：游戏账号信息为板块内标题。
    expect(within(panel).getAllByText("游戏账号信息").length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getByText("操作明细")).toBeInTheDocument();
    // 资金明细与操作明细均含「操作人」列，合并校验至少出现一次。
    expect(within(panel).getAllByText("操作人").length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getAllByText("admin").length).toBeGreaterThanOrEqual(2);
    expect(within(panel).getAllByText("100.00").length).toBeGreaterThanOrEqual(2);
    expect(within(panel).getByText("回收成本")).toBeInTheDocument();
    expect(within(panel).getByText("总支出")).toBeInTheDocument();
  });

  it("详情态展示账号密码明文并支持复制", () => {
    const accountWithPassword = { ...account, game_password: "secret-password", game_type: "原神" } as unknown as Account;
    render(<OrderDetail row={accountWithPassword} detail={{ orders: [] } as unknown as AccountExecutionDetail} loading={false} />);
    const panel = document.querySelector(".order-detail") as HTMLElement;
    expect(within(panel).getByText("secret-password")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "复制账号密码" })).toBeInTheDocument();
  });

  it("参与方按角色与名称展示，并可打开客户中心卡片", () => {
    const onPartyClick = vi.fn();
    const detail = {
      orders: [{
        order_id: 1,
        order_no: "HS0001",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        customers: [
          { id: 7, display_name: "买家A", role: "BUYER" },
          { id: 8, display_name: "卖家B", role: "SELLER" },
        ],
        counterparties: [{ id: 11, display_name: "平台A", role: "PLATFORM" }],
        events: [],
      }],
      detail_view: {
        operation_rows: [],
        execution_rows: [],
        finance_rows: [],
        lifecycle: { removed_platform: "-", recovery_platform: "-", sale_platform: "-" },
        order_notes: "-",
        parties: [
          { id: 7, display_name: "买家A", role: "BUYER", entity_type: "customer" },
          { id: 8, display_name: "卖家B", role: "SELLER", entity_type: "customer" },
          { id: 11, display_name: "平台A", role: "PLATFORM", entity_type: "counterparty" },
        ],
        extras: [],
      },
    } as unknown as AccountExecutionDetail;

    render(<OrderDetail row={account} detail={detail} loading={false} onPartyClick={onPartyClick} />);

    const buyer = screen.getByRole("link", { name: "客户_买家：买家A" });
    expect(screen.getByRole("link", { name: "客户_卖家：卖家B" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "合作方_平台：平台A" })).toBeInTheDocument();
    fireEvent.click(buyer);
    expect(onPartyClick).toHaveBeenCalledWith({ id: 7, display_name: "买家A", role: "BUYER", entity_type: "customer", entityType: "customer" });
  });

  it("展开详情按基础/执行/资金分区，并保留信息表与四个运营动作", () => {
    render(<OrderDetail row={account} detail={{ orders: [] } as unknown as AccountExecutionDetail} loading={false} />);
    const panel = document.querySelector(".order-detail") as HTMLElement;
    // 已移除的冗余分组不应再出现
    expect(within(panel).queryByText("登记与流转信息")).toBeNull();
    expect(within(panel).queryByText("其他补充信息")).toBeNull();
    expect(within(panel).queryByText("主订单信息")).toBeNull();
    expect(within(panel).getByText("运营信息")).toBeInTheDocument();
    expect(within(panel).getByText("上架平台")).toBeInTheDocument();
    expect(within(panel).getByText("下架平台")).toBeInTheDocument();
    expect(panel.querySelector(".order-detail__meta")).toBeTruthy();
    expect(panel.querySelector(".order-detail__section--execution")).toBeTruthy();
    expect(panel.querySelector(".order-detail__section--finance")).toBeTruthy();
    expect(panel.querySelector(".order-finance-summary__item--amount")).toBeTruthy();

    expect(panel.querySelector(".order-detail__meta-table")).toBeTruthy();
    const accountTable = panel.querySelector(".order-detail__section--profile .order-detail__meta-table");
    expect(within(panel).getByText("账号资料")).toBeInTheDocument();
    expect(accountTable?.querySelectorAll("tbody > tr").length).toBeGreaterThan(0);

    const operationSection = panel.querySelector(".order-detail__section--operation") as HTMLElement;
    expect(within(operationSection).getByText("上架平台")).toBeInTheDocument();
    expect(within(operationSection).getByText("下架平台")).toBeInTheDocument();
    expect(within(operationSection).getByText("描述")).toBeInTheDocument();
    expect(within(operationSection).getByText("作图")).toBeInTheDocument();
    expect(within(operationSection).queryByText("当前运营状态")).toBeNull();
  });

  it.each([
    ["HS", "回收操作人"],
    ["TH", "提号操作人"],
    ["DG", "代挂操作人"],
  ])("%s 账号资料展示本单%s，不混入交付或其他订单人员", async (orderType, label) => {
    const detail = {
      account,
      orders: [
        { order_id: 2, order_no: "HS0002", order_type: "HS", operator: "其他订单人员", events: [] },
        {
          order_id: 1,
          order_no: `${orderType}0001`,
          order_type: orderType,
          operator: "何一、何二",
          operator_user_ids: [1, 2],
          extra_values: { business_responsible_ids: [1, 2], delivery_responsible_ids: [3] },
          latest_sale_event_id: 1,
          events: [{ id: 1, event_type: "SELL", operator: "售出人员" }],
        },
      ],
      detail_view: { operation_rows: [], execution_rows: [], finance_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] },
      finance_summary: { total_expense: "0.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;

    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={1} loading={false} />);
    await settleFieldConfig();

    const profile = document.querySelector(".order-detail__section--profile") as HTMLElement;
    expect(within(profile).getByText(label)).toBeInTheDocument();
    expect(within(profile).getByText("何一、何二")).toBeInTheDocument();
    expect(within(profile).queryByText("售出人员")).toBeNull();
    expect(within(profile).queryByText("其他订单人员")).toBeNull();
  });

  it("编辑执行明细时操作员选择器保持可读宽度", async () => {
    const detail = {
      orders: [{
        order_id: 1,
        order_no: "HS0001",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        events: [{
          id: 1,
          event_no: "EV0001",
          event_type: "BUY",
          amount: "100.00",
          occurred_at: "2026-10-15T10:20:00",
          operator: "admin",
          operator_user_ids: [7],
          note: "回收登记",
          cashflow: { flow_no: "CF0001", direction: "OUT", amount: "100.00" },
        }],
        rebates: [],
      }],
      detail_view: {
        operation_rows: [],
        execution_rows: [{ key: "buy", order_id: 1, category: "INBOUND", action: "回收入库", occurred_at: "2026-10-15T10:20:00", amount: "100.00", operator: "admin", note: "回收登记", platform: "-", event_id: 1 }],
        finance_rows: [],
        lifecycle: { removed_platform: "-", recovery_platform: "-", sale_platform: "-" },
        order_notes: "-",
        parties: [],
        extras: [],
      },
    } as unknown as AccountExecutionDetail;

    renderApp(<OrderDetail row={account} detail={detail} loading={false} editing={account} employees={[{ id: 7, username: "zhangsan", display_name: "张三", is_active: true }]} />);
    await settleFieldConfig();
    expect(document.querySelector(".inventory-edit-operator")).toBeTruthy();
  });

  it("编辑详情时缺失的操作人统一默认当前员工", async () => {
    const detail = {
      orders: [{
        order_id: 1,
        order_no: "HS0001",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        extra_values: { delivery_responsible_ids: [] },
        events: [
          {
            id: 1,
            event_no: "EV0001",
            event_type: "BUY",
            amount: "100.00",
            occurred_at: "2026-10-15T10:20:00",
            operator_user_ids: [],
            note: "回收登记",
          },
          {
            id: 2,
            event_no: "EV0002",
            event_type: "OPERATE",
            operation_type: "CONSIGNMENT",
            occurred_at: "2026-10-15T10:21:00",
            form_extra: { consignment_platforms: ["千寻"] },
            operator_user_ids: [],
            amount: "0.00",
            note: "寄售上架：千寻",
          },
        ],
        rebates: [],
      }],
      detail_view: {
        operation_rows: [{ key: "consignment", action: "上架平台", content: "千寻", occurred_at: "2026-10-15T10:21:00", operator: "-", event_id: 2 }],
        execution_rows: [{ key: "buy", order_id: 1, category: "INBOUND", action: "回收入库", occurred_at: "2026-10-15T10:20:00", amount: "100.00", operator: "-", operator_user_ids: [], note: "回收登记", platform: "-", event_id: 1 }],
        finance_rows: [{ key: "CF0001", flow_no: "CF0001", type: "回收成本", direction: "支出", amount: "100.00", occurred_at: "2026-10-15T10:20:00", pool_name: "经营荷包", note: "回收登记", operator: "-", operator_user_ids: [] }],
        lifecycle: { removed_platform: "-", recovery_platform: "-", sale_platform: "-" },
        order_notes: "-",
        parties: [],
        extras: [],
      },
      finance_summary: { total_expense: "100.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;

    renderApp(<OrderDetail row={account} detail={detail} loading={false} editing={account} employees={[{ id: 1, username: "admin", display_name: "管理员", is_active: true }]} />);
    await settleFieldConfig();

    expect(screen.getByRole("combobox", { name: "编辑执行操作人 回收入库" }).closest(".ant-select")?.textContent).toContain("管理员");
    expect(screen.getByRole("combobox", { name: "编辑上架平台操作人" }).closest(".ant-select")?.textContent).toContain("管理员");
    expect(screen.getByRole("combobox", { name: "编辑资金明细操作人 CF0001" }).closest(".ant-select")?.textContent).toContain("管理员");
    expect(screen.getByRole("combobox", { name: "编辑交付操作人" }).closest(".ant-select")?.textContent).toContain("管理员");
  });

  it("入库执行行沿用建单业务操作人并支持多选编辑", async () => {
    const onOrderExtraChange = vi.fn();
    const detail = {
      orders: [{
        order_id: 1,
        order_no: "HS0001",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        extra_values: { business_responsible_ids: [7] },
        events: [],
        rebates: [],
      }],
      detail_view: {
        operation_rows: [],
        execution_rows: [{
          key: "inventory-entry",
          order_id: 1,
          category: "INBOUND",
          action: "回收入库",
          occurred_at: "2026-10-15T10:19:00",
          amount: null,
          operator: "张三",
          operator_user_ids: [7],
          note: "-",
          platform: "-",
        }],
        finance_rows: [],
        lifecycle: { removed_platform: "-", recovery_platform: "-", sale_platform: "-" },
        order_notes: "-",
        parties: [],
        extras: [],
      },
      finance_summary: { total_expense: "0.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;

    renderApp(
      <OrderDetail
        row={account}
        detail={detail}
        loading={false}
        editing={account}
        employees={[
          { id: 7, username: "zhangsan", display_name: "张三", is_active: true },
          { id: 8, username: "lisi", display_name: "李四", is_active: true },
        ]}
        onOrderExtraChange={onOrderExtraChange}
      />,
    );
    await settleFieldConfig();

    const operator = screen.getByRole("combobox", { name: "编辑执行操作人 回收入库" });
    expect(operator.closest(".inventory-edit-operator")).toBeTruthy();
    await userEvent.click(operator);
    await userEvent.click(await screen.findByText("李四", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(1, "business_responsible_ids", [7, 8]);
  });

  it("有买入事件时编辑入库操作人仍更新建单业务操作人", async () => {
    const onOrderExtraChange = vi.fn();
    const onEventEdit = vi.fn();
    const detail = {
      orders: [{
        order_id: 1,
        order_no: "HS0001",
        order_type: "HS",
        operator: "张三",
        extra_values: { business_responsible_ids: [7] },
        events: [{ id: 1, event_type: "BUY", operator_user_ids: [8] }],
      }],
      detail_view: {
        operation_rows: [],
        execution_rows: [{ key: "buy", order_id: 1, category: "INBOUND", action: "回收入库", operator: "张三", operator_user_ids: [7], event_id: 1 }],
        finance_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [],
      },
      finance_summary: { total_expense: "0.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;

    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={1} loading={false} editing={account}
      employees={[
        { id: 7, username: "zhangsan", display_name: "张三", is_active: true },
        { id: 8, username: "lisi", display_name: "李四", is_active: true },
      ]} onOrderExtraChange={onOrderExtraChange} onEventEdit={onEventEdit} />);
    await settleFieldConfig();

    const operator = screen.getByRole("combobox", { name: "编辑执行操作人 回收入库" });
    expect(operator.closest(".ant-select")).toHaveTextContent("张三");
    await userEvent.click(operator);
    await userEvent.click(await screen.findByText("李四", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(1, "business_responsible_ids", [7, 8]);
    expect(onEventEdit).not.toHaveBeenCalled();
  });

  it("编辑入库操作人时账号资料同步展示未保存的人员", async () => {
    const detail = {
      orders: [{ order_id: 1, order_no: "HS0001", order_type: "HS", operator: "张三", operator_user_ids: [7], events: [] }],
      detail_view: { operation_rows: [], execution_rows: [], finance_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] },
      finance_summary: { total_expense: "0.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;
    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={1} loading={false} editing={account}
      employees={[
        { id: 7, username: "zhangsan", display_name: "张三", is_active: true },
        { id: 8, username: "lisi", display_name: "李四", is_active: true },
      ]}
      orderDrafts={{ 1: { order_id: 1, occurred_at: "", note: "", form_extra: { business_responsible_ids: [7, 8] } } }} />);
    await settleFieldConfig();

    const profile = document.querySelector(".order-detail__section--profile") as HTMLElement;
    expect(within(profile).getByText("张三、李四")).toBeInTheDocument();
  });

  it("编辑态账号输入与运营动作字段都绑定可编辑状态", async () => {
    const detail = {
      account: { ...account, game_account: "原账号" },
      orders: [{
        order_id: 21,
        order_no: "DG0021",
        order_type: "DG",
        created_at: "2026-10-15T10:19:00",
        events: [{
          id: 2101,
          event_type: "OPERATE",
          operation_type: "CONSIGNMENT",
          occurred_at: "2026-10-15T10:20:00",
          form_extra: { consignment_platforms: ["千寻"] },
          operator_user_ids: [7],
          amount: "0.00",
          note: "寄售上架：千寻",
        }, {
          id: 2102,
          event_type: "OPERATE",
          operation_type: "CONSIGNMENT",
          occurred_at: "2026-10-16T11:20:00",
          form_extra: { consignment_platforms: ["盼之"], consignment_price: 88 },
          operator_user_ids: [7],
          amount: "0.00",
          note: "寄售上架：盼之",
        }],
        rebates: [],
      }],
      detail_view: {
        operation_rows: [{
          key: "consignment",
          action: "上架平台",
          content: "千寻",
          occurred_at: "2026-10-15T10:20:00",
          operator: "张三",
          event_id: 2102,
        }, { key: "unlist", action: "下架平台", content: "-", occurred_at: null, operator: "-", event_id: null },
        { key: "description", action: "描述", content: "-", occurred_at: null, operator: "-", event_id: null },
        { key: "images", action: "作图", content: "-", occurred_at: null, operator: "-", event_id: null }],
        finance_rows: [],
        execution_rows: [],
        lifecycle: { sold_at: null, removed_at: null, removed_platform: "-", recovery_platform: "-", sale_platform: "-" },
        order_notes: "-",
        parties: [],
        extras: [],
      },
      finance_summary: { total_expense: "0.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;

    const onProfileChange = vi.fn();
    const onAddOperationRow = vi.fn();
    renderApp(<OrderDetail row={account} detail={detail} loading={false} editing={account} onProfileChange={onProfileChange} onAddOperationRow={onAddOperationRow} employees={[{ id: 7, username: "zhangsan", display_name: "张三", is_active: true }]} />);
    await settleFieldConfig();

    const accountInput = screen.getByLabelText("编辑游戏账号 / 产品") as HTMLInputElement;
    fireEvent.change(accountInput, { target: { value: "新账号" } });
    expect(onProfileChange).toHaveBeenCalledWith({ game_account: "新账号" });
    expect(screen.getByRole("combobox", { name: "编辑上架平台" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "编辑上架平台 2" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "编辑寄售价格" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "编辑寄售价格" }).closest(".ant-input-number-affix-wrapper")).toHaveTextContent("元");
    expect(screen.getByRole("combobox", { name: "编辑上架平台操作人" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "编辑下架平台" })).toBeInTheDocument();
    expect(screen.getByLabelText("编辑上架平台时间")).toBeInTheDocument();
    expect(screen.getByLabelText("编辑下架平台时间")).toBeInTheDocument();
    expect(screen.getByLabelText("编辑描述时间")).toBeInTheDocument();
    expect(screen.getByLabelText("编辑作图时间")).toBeInTheDocument();
    expect(screen.getByLabelText("上传作图")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ 添加上架行" }));
    expect(onAddOperationRow).toHaveBeenCalledWith("CONSIGNMENT");
  });

  it("新增上架行按动作分组插入，并且可以删除新增行", async () => {
    const onRemoveOperationRow = vi.fn();
    const detail = {
      orders: [{ order_id: 1, order_no: "DG0001", order_type: "DG", created_at: "2026-10-15T10:19:00", events: [], rebates: [] }],
      detail_view: {
        operation_rows: [
          { key: "consignment", action: "上架平台", content: "千寻", occurred_at: null, operator: "-", event_id: null },
          { key: "unlist", action: "下架平台", content: "-", occurred_at: null, operator: "-", event_id: null },
          { key: "description", action: "描述", content: "-", occurred_at: null, operator: "-", event_id: null },
          { key: "images", action: "作图", content: "-", occurred_at: null, operator: "-", event_id: null },
        ],
        finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [],
      },
      finance_summary: { total_expense: "0.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;
    const operationDrafts = {
      "new:consignment:1": { operation_type: "CONSIGNMENT" as const, occurred_at: "", form_extra: {} },
      "new:unlist:2": { operation_type: "UNLIST" as const, occurred_at: "", form_extra: {} },
    };
    renderApp(
      <OrderDetail
        row={account}
        detail={detail}
        loading={false}
        editing={account}
        operationDrafts={operationDrafts}
        onRemoveOperationRow={onRemoveOperationRow}
      />,
    );
    await settleFieldConfig();

    const operationRows = Array.from(document.querySelectorAll(".order-operation-table tbody tr"));
    expect(operationRows.slice(1).map((row) => row.textContent?.trim().slice(0, 4))).toEqual(["上架平台", "上架平台", "下架平台", "下架平台", "描述", "作图上传"]);
    await fireEvent.click(screen.getByRole("button", { name: "删除新增上架平台" }));
    expect(onRemoveOperationRow).toHaveBeenCalledWith("new:consignment:1");
    await fireEvent.click(screen.getByRole("button", { name: "删除新增下架平台" }));
    expect(onRemoveOperationRow).toHaveBeenCalledWith("new:unlist:2");
  });

  it("订单参与方按关键词向后端搜索客户", async () => {
    const detail = { orders: [{ order_id: 22, order_no: "HS0022", order_type: "HS", customers: [], counterparties: [], events: [] }], detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] }, finance_summary: { total_expense: "0", total_income: "0" } } as unknown as AccountExecutionDetail;
    vi.spyOn(customersApi, "options").mockImplementation(async (keyword) => keyword === "远端客户" ? [{ id: 33, customer_no: "C033", display_name: "远端客户" }] : []);
    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={22} loading={false} editing={account} employees={[]} />);
    const select = await screen.findByRole("combobox", { name: "选择卖家" });
    await userEvent.type(select, "远端客户");
    expect(await screen.findByRole("option", { name: /远端客户/ })).toBeInTheDocument();
  });

  it("新建参与方前精确查找已有客户并复用", async () => {
    const detail = { orders: [{ order_id: 22, order_no: "HS0022", order_type: "HS", customers: [], counterparties: [], events: [] }], detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] }, finance_summary: { total_expense: "0", total_income: "0" } } as unknown as AccountExecutionDetail;
    vi.mocked(customersApi.options).mockImplementation(async (name, exact) => exact && name === "已有卖家" ? [{ id: 9, customer_no: "C009", display_name: "已有卖家" }] : []);
    const create = vi.spyOn(customersApi, "create");
    const onPartyEdit = vi.fn();
    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={22} loading={false} editing={account} employees={[]} onPartyEdit={onPartyEdit} />);
    const select = await screen.findByRole("combobox", { name: "选择卖家" });
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.type(select, "已有卖家");
    await userEvent.click(screen.getByRole("button", { name: /新建卖家/ }));
    await waitFor(() => expect(onPartyEdit).toHaveBeenCalledWith(22, { entity_type: "customer", entity_id: 9, role: "SELLER" }));
    expect(create).not.toHaveBeenCalled();
  });

  it("编辑参与方时保留已有客户角色，并按原角色移除买家", async () => {
    const detail = { orders: [{ order_id: 22, order_no: "HS0022", order_type: "HS", customers: [{ id: 1, display_name: "卖家", role: "SELLER" }, { id: 2, display_name: "买家", role: "BUYER" }], counterparties: [], events: [] }], detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] }, finance_summary: { total_expense: "0", total_income: "0" } } as unknown as AccountExecutionDetail;
    vi.spyOn(customersApi, "options").mockResolvedValue([{ id: 1, customer_no: "C001", display_name: "卖家" }, { id: 2, customer_no: "C002", display_name: "买家" }, { id: 3, customer_no: "C003", display_name: "新客户" }]);
    const onPartyEdit = vi.fn();
    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={22} loading={false} editing={account} employees={[]} onPartyEdit={onPartyEdit} />);
    const select = await screen.findByRole("combobox", { name: "选择卖家" });
    await waitFor(() => expect(select).toBeEnabled());
    expect(screen.getByRole("combobox", { name: "选择买家" })).toBeInTheDocument();
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole("option", { name: /新客户/ }));
    expect(onPartyEdit).toHaveBeenCalledTimes(1);
    expect(onPartyEdit).toHaveBeenCalledWith(22, { entity_type: "customer", entity_id: 3, role: "SELLER" });
    onPartyEdit.mockClear();
    const buyerTag = screen.getAllByTitle("C002 · 买家").find((item) => item.closest(".ant-select-selection-item"))!.closest(".ant-select-selection-item")!;
    await userEvent.click(within(buyerTag as HTMLElement).getByLabelText("close"));
    expect(onPartyEdit).toHaveBeenCalledTimes(1);
    expect(onPartyEdit).toHaveBeenCalledWith(22, { entity_type: "customer", entity_id: 2, role: "BUYER", operation: "remove" });
  });

  it.each([
    ["HS", ["选择卖家", "选择买家"], false],
    ["TH", ["选择买家"], true],
    ["DG", ["选择委托方"], true],
  ])("%s 订单按业务类型显示参与方角色", async (orderType, customerLabels, hasPartner) => {
    const detail = { orders: [{ order_id: 22, order_no: "TEST0022", order_type: orderType, customers: [], counterparties: [], events: [] }], detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] }, finance_summary: { total_expense: "0", total_income: "0" } } as unknown as AccountExecutionDetail;
    vi.spyOn(customersApi, "options").mockResolvedValue([]);
    vi.spyOn(counterpartiesApi, "list").mockResolvedValue([]);
    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={22} loading={false} editing={account} employees={[]} />);
    for (const label of customerLabels) expect(await screen.findByRole("combobox", { name: label })).toBeInTheDocument();
    expect(Boolean(screen.queryByRole("combobox", { name: "选择合作方" }))).toBe(hasPartner);
  });

  it.each([ ["HS", "选择卖家", "新建卖家"], ["TH", "选择合作方", "新建合作方"] ])("%s 新建参与方请求期间快速重复点击只创建一次", async (orderType, selectName, buttonName) => {
    const detail = { orders: [{ order_id: 22, order_no: "TEST0022", order_type: orderType, customers: [], counterparties: [], events: [] }], detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] }, finance_summary: { total_expense: "0", total_income: "0" } } as unknown as AccountExecutionDetail;
    vi.spyOn(customersApi, "options").mockResolvedValue([]);
    vi.spyOn(counterpartiesApi, "list").mockResolvedValue([]);
    let finish!: (value: never) => void;
    const pending = new Promise<never>((resolve) => { finish = resolve; });
    const create = orderType === "HS" ? vi.spyOn(customersApi, "create").mockReturnValue(pending) : vi.spyOn(counterpartiesApi, "create").mockReturnValue(pending);
    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={22} loading={false} editing={account} employees={[]} />);
    const select = await screen.findByRole("combobox", { name: selectName });
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.type(select, "新参与方");
    const button = screen.getByRole("button", { name: new RegExp(buttonName) });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await act(async () => { finish((orderType === "HS" ? { customer: { id: 10, customer_no: "C010", display_name: "新参与方", status: "ACTIVE" }, duplicate_candidates: [] } : { id: 10, counterparty_no: "CP010", display_name: "新参与方", type: "PEER", status: "ACTIVE" }) as never); await pending; });
  });

  it.each([ ["HS", "选择卖家", "新建卖家"], ["TH", "选择合作方", "新建合作方"] ])("%s 新建参与方完成时，不写入后来切换的订单", async (orderType, selectName, buttonName) => {
    const detail = (id: number) => ({ orders: [{ order_id: id, order_no: `TEST${id}`, order_type: orderType, customers: [], counterparties: [], events: [] }], detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] }, finance_summary: { total_expense: "0", total_income: "0" } }) as unknown as AccountExecutionDetail;
    vi.spyOn(customersApi, "options").mockResolvedValue([]);
    vi.spyOn(counterpartiesApi, "list").mockResolvedValue([]);
    let finish!: (value: never) => void;
    const pending = new Promise<never>((resolve) => { finish = resolve; });
    const create = orderType === "HS" ? vi.spyOn(customersApi, "create").mockReturnValue(pending) : vi.spyOn(counterpartiesApi, "create").mockReturnValue(pending);
    const onPartyEdit = vi.fn();
    const { rerender } = renderApp(<OrderDetail row={account} detail={detail(22)} contextOrderId={22} loading={false} editing={account} employees={[]} onPartyEdit={onPartyEdit} />);
    const select = await screen.findByRole("combobox", { name: selectName });
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.type(select, "新参与方");
    await userEvent.click(screen.getByRole("button", { name: new RegExp(buttonName) }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    rerender(<OrderDetail row={account} detail={detail(23)} contextOrderId={23} loading={false} editing={account} employees={[]} onPartyEdit={onPartyEdit} />);
    await act(async () => finish((orderType === "HS" ? { customer: { id: 10, customer_no: "C010", display_name: "新参与方", status: "ACTIVE" }, duplicate_candidates: [] } : { id: 10, counterparty_no: "CP010", display_name: "新参与方", type: "PEER", status: "ACTIVE" }) as never));
    expect(onPartyEdit).not.toHaveBeenCalled();
  });

  it("参与方多选支持输入新名字并在下拉中新建", async () => {
    const detail = { orders: [{ order_id: 22, order_no: "HS0022", order_type: "HS", customers: [], counterparties: [], events: [] }], detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] }, finance_summary: { total_expense: "0", total_income: "0" } } as unknown as AccountExecutionDetail;
    vi.spyOn(customersApi, "options").mockResolvedValue([]);
    const create = vi.spyOn(customersApi, "create").mockResolvedValue({ customer: { id: 10, customer_no: "C010", display_name: "新卖家", status: "ACTIVE" }, duplicate_candidates: [] } as never);
    const onPartyEdit = vi.fn();
    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={22} loading={false} editing={account} employees={[]} onPartyEdit={onPartyEdit} />);
    const select = await screen.findByRole("combobox", { name: "选择卖家" });
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.type(select, "新卖家");
    await userEvent.click(screen.getByRole("button", { name: /新建卖家/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ display_name: "新卖家" }));
    expect(onPartyEdit).toHaveBeenCalledWith(22, { entity_type: "customer", entity_id: 10, role: "SELLER" });
  });

  it("客户名单加载失败时保留渠道方选择，并可重试客户加载", async () => {
    const detail = { orders: [{ order_id: 22, order_no: "TH0022", order_type: "TH", customers: [], counterparties: [], events: [] }], detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] }, finance_summary: { total_expense: "0", total_income: "0" } } as unknown as AccountExecutionDetail;
    vi.spyOn(customersApi, "options").mockRejectedValueOnce(new Error("客户名单读取失败")).mockResolvedValue([{ id: 1, customer_no: "C001", display_name: "已有客户" }]);
    vi.spyOn(customersApi, "create");
    vi.spyOn(counterpartiesApi, "list").mockResolvedValue([{ id: 2, counterparty_no: "CP002", display_name: "渠道甲", type: "PEER", status: "ACTIVE" }] as never);
    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={22} loading={false} editing={account} employees={[]} />);
    expect(await screen.findByText(/客户名单读取失败/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "选择买家" })).toBeDisabled();
    await userEvent.click(screen.getByRole("combobox", { name: "选择合作方" }));
    expect(await screen.findByRole("option", { name: /渠道甲/ })).toBeInTheDocument();
    const alert = screen.getByText(/客户名单读取失败/).closest('[role="alert"]') as HTMLElement;
    await userEvent.click(within(alert).getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "选择买家" })).toBeEnabled());
    await userEvent.click(screen.getByRole("combobox", { name: "选择买家" }));
    expect(await screen.findByRole("option", { name: /已有客户/ })).toBeInTheDocument();
    expect(customersApi.create).not.toHaveBeenCalled();
  });

  it("渠道方名单加载失败时保留客户选择，并可重试渠道方加载", async () => {
    const detail = { orders: [{ order_id: 22, order_no: "TH0022", order_type: "TH", customers: [], counterparties: [], events: [] }], detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] }, finance_summary: { total_expense: "0", total_income: "0" } } as unknown as AccountExecutionDetail;
    vi.spyOn(customersApi, "options").mockResolvedValue([{ id: 1, customer_no: "C001", display_name: "已有客户" }]);
    vi.spyOn(counterpartiesApi, "list").mockRejectedValueOnce(new Error("渠道名单读取失败")).mockResolvedValue([{ id: 2, counterparty_no: "CP002", display_name: "渠道甲", type: "PEER", status: "ACTIVE" }] as never);
    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={22} loading={false} editing={account} employees={[]} />);
    expect(await screen.findByText(/渠道名单读取失败/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "选择合作方" })).toBeDisabled();
    await userEvent.click(screen.getByRole("combobox", { name: "选择买家" }));
    expect(await screen.findByRole("option", { name: /已有客户/ })).toBeInTheDocument();
    const alert = screen.getByText(/渠道名单读取失败/).closest('[role="alert"]') as HTMLElement;
    await userEvent.click(within(alert).getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "选择合作方" })).toBeEnabled());
    await userEvent.click(screen.getByRole("combobox", { name: "选择合作方" }));
    expect(await screen.findByRole("option", { name: /渠道甲/ })).toBeInTheDocument();
  });

  it("客户较多时下拉只渲染可见选项，仍能搜索末尾客户", async () => {
    const customers = Array.from({ length: 500 }, (_, index) => ({ id: index + 1, customer_no: `C${index + 1}`, display_name: `客户${index + 1}`, status: "ACTIVE" }));
    const detail = { orders: [{ order_id: 22, order_no: "HS0022", order_type: "HS", customers: [], counterparties: [], events: [] }], detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] }, finance_summary: { total_expense: "0", total_income: "0" } } as unknown as AccountExecutionDetail;
    vi.spyOn(customersApi, "options").mockImplementation(async (keyword) => keyword ? customers.filter((item) => item.display_name.includes(keyword)).slice(0, 20) : customers.slice(0, 20));
    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={22} loading={false} editing={account} employees={[]} />);
    const select = await screen.findByRole("combobox", { name: "选择卖家" });
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.click(select);
    await waitFor(() => expect(document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").length).toBeGreaterThan(0));
    expect(document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").length).toBeLessThan(100);
    await userEvent.type(select, "客户500");
    expect(await screen.findByRole("option", { name: /客户500/ })).toBeInTheDocument();
  });

  it("编辑参与方可选择第500条以后的客户", async () => {
    const first = Array.from({ length: 500 }, (_, index) => ({ id: index + 1, customer_no: `C${index + 1}`, display_name: `客户${index + 1}`, status: "ACTIVE" }));
    const last = { id: 501, customer_no: "C501", display_name: "末尾客户", status: "ACTIVE" };
    vi.spyOn(customersApi, "options").mockImplementation(async (keyword) => keyword === "末尾客户" ? [last] : first.slice(0, 20));
    vi.spyOn(counterpartiesApi, "list").mockResolvedValue([]);
    const detail = { orders: [{ order_id: 22, order_no: "HS0022", order_type: "HS", customers: [], counterparties: [], events: [] }], detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] }, finance_summary: { total_expense: "0", total_income: "0" } } as unknown as AccountExecutionDetail;
    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={22} loading={false} editing={account} employees={[]} />);
    const select = await screen.findByRole("combobox", { name: "选择卖家" });
    await userEvent.click(select);
    await userEvent.type(select, "末尾客户");
    expect(await screen.findByRole("option", { name: /末尾客户/ })).toBeInTheDocument();
  });

  it("编辑参与方时按订单类型提供客户或渠道方的新建与选择控件", async () => {
    const detail = {
      orders: [{
        order_id: 22,
        order_no: "HS0022",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        customers: [],
        counterparties: [],
        events: [],
      }],
      detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] },
      finance_summary: { total_expense: "0.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;

    vi.spyOn(customersApi, "options").mockImplementation(async (keyword) => [{ id: 1, customer_no: "C001", display_name: "买家A" }, { id: 2, customer_no: "C002", display_name: "卖家B" }].filter((item) => !keyword || item.display_name.includes(keyword)));
    vi.spyOn(counterpartiesApi, "list").mockResolvedValue([] as never);
    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={22} loading={false} editing={account} employees={[]} />);
    await settleFieldConfig();

    const customerSelect = screen.getByRole("combobox", { name: "选择卖家" });
    await userEvent.click(customerSelect);
    await waitFor(() => expect(screen.getByRole("option", { name: /买家A/ })).toBeInTheDocument());
    await userEvent.type(customerSelect, "买家A");
    expect(screen.getByRole("option", { name: /买家A/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("option", { name: /卖家B/ })).not.toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "选择买家" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "选择合作方" })).toBeNull();

  });

  it("编辑态账号与交付补充资料可以修改并写入对应草稿", async () => {
    vi.spyOn(orderFormFieldsApi, "list").mockImplementation(async (scope) => {
      if (scope === "DG") {
        return [
          { id: 901, order_type_code: "DG", field_key: "account_tag", label: "账号标签", field_type: "TEXT", options: null, required: false, is_active: true, sort_order: 1, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT", note: null },
          { id: 902, order_type_code: "DG", field_key: "delivery_note", label: "交付备注", field_type: "TEXT", options: null, required: false, is_active: true, sort_order: 2, locked: false, is_custom: true, section: "DELIVER", note: null },
        ];
      }
      return [];
    });
    const detail = {
      account: { ...account, extra_values: { account_tag: "旧标签" } },
      orders: [{ order_id: 31, order_no: "DG0031", order_type: "DG", created_at: "2026-10-15T10:19:00", extra_values: { delivery_note: "旧交付备注" }, events: [] }],
      detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [{ key: "delivery_note", label: "交付备注", value: "旧交付备注", section: "DELIVER" }] },
      finance_summary: { total_expense: "0.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;
    const onProfileChange = vi.fn();
    const onOrderExtraChange = vi.fn();
    renderApp(<OrderDetail row={{ ...account, extra_values: { account_tag: "旧标签" } } as Account} detail={detail} contextOrderId={31} loading={false} editing={{ ...account, extra_values: { account_tag: "旧标签" } } as Account} onProfileChange={onProfileChange} onOrderExtraChange={onOrderExtraChange} employees={[]} />);
    await settleFieldConfig();

    await waitFor(() => expect(screen.getByDisplayValue("旧标签")).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue("旧标签"), { target: { value: "新标签" } });
    expect(onProfileChange).toHaveBeenCalledWith({ extra_values: { account_tag: "新标签" } });
    const delivery = screen.getByDisplayValue("旧交付备注");
    fireEvent.change(delivery, { target: { value: "新交付备注" } });
    expect(onOrderExtraChange).toHaveBeenCalledWith(31, "delivery_note", "新交付备注");
  });

  it("编辑态交付字段以账号草稿为唯一来源，不回退到旧订单快照", async () => {
    const detail = {
      account: { ...account, bound_phone: "新手机号" },
      orders: [{
        order_id: 33,
        order_no: "HS0033",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        extra_values: { bound_phone: "旧手机号", bound_phone_owner: "旧绑定人" },
        events: [],
      }],
      detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] },
      finance_summary: { total_expense: "0.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;

    renderApp(<OrderDetail row={{ ...account, bound_phone: "新手机号" } as Account} detail={detail} loading={false} editing={{ ...account, bound_phone: "新手机号" } as Account} employees={[]} />);
    await settleFieldConfig();

    expect(screen.getByLabelText("编辑换绑手机号")).toHaveValue("新手机号");
    expect(screen.getByLabelText("编辑手机号绑定人")).toHaveValue("");
  });

  it("编辑详情不再展示时间联动入口，时间直接在操作明细中修改", async () => {
    const detail = {
      orders: [{ order_id: 32, order_no: "HS0032", order_type: "HS", created_at: "2026-10-15T10:19:00", events: [] }],
      detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] },
      finance_summary: { total_expense: "0.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;

    renderApp(<OrderDetail row={account} detail={detail} loading={false} editing={account} employees={[]} />);
    await settleFieldConfig();

    expect(screen.queryByText("时间联动")).toBeNull();
    expect(screen.queryByLabelText("编辑订单创建时间")).toBeNull();
  });

  it("编辑态资金明细的时间、操作人和备注可以修改", async () => {
    const detail = {
      orders: [{ order_id: 36, order_no: "HS0036", order_type: "HS", created_at: "2026-10-15T10:19:00", events: [] }],
      detail_view: {
        operation_rows: [],
        execution_rows: [],
        finance_rows: [{ key: "CF0036", flow_no: "CF0036", type: "回收成本", direction: "支出", amount: "100.00", occurred_at: "2026-10-15T10:20:00", pool_name: "经营荷包", note: "旧备注", operator: "admin", operator_user_ids: [1] }],
        lifecycle: {},
        order_notes: "-",
        parties: [],
        extras: [],
      },
      finance_summary: { total_expense: "100.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;

    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={36} loading={false} editing={account} employees={[{ id: 1, username: "admin", display_name: "管理员", is_active: true }]} />);
    await settleFieldConfig();

    expect(screen.getByLabelText("编辑资金明细时间 CF0036")).toBeInTheDocument();
    expect(document.querySelector('.ant-select[aria-label="编辑资金明细操作人 CF0036"]')?.textContent).toContain("管理员");
    expect(screen.getByLabelText("编辑资金明细备注 CF0036")).toHaveValue("旧备注");
  });

  it("编辑态资金明细时间完整显示，并可修改金额和资金账户", async () => {
    const onFinanceEdit = vi.fn();
    const detail = {
      orders: [{ order_id: 37, order_no: "HS0037", order_type: "HS", created_at: "2026-10-15T10:19:00", events: [] }],
      detail_view: {
        operation_rows: [],
        execution_rows: [],
        finance_rows: [{ key: "CF0037", flow_no: "CF0037", type: "回收成本", direction: "支出", amount: "100.00", occurred_at: "2026-10-15T10:20:00", pool_id: 1, pool_name: "经营荷包", note: "旧备注", operator: "admin", operator_user_ids: [1] }],
        lifecycle: {},
        order_notes: "-",
        parties: [],
        extras: [],
      },
      finance_summary: { total_expense: "100.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;

    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={37} loading={false} editing={account} employees={[{ id: 1, username: "admin", display_name: "管理员", is_active: true }]} pools={[
      { id: 1, code: "HJ_INVEST", name: "经营荷包", pool_type: "INVEST", status: "ACTIVE" },
      { id: 2, code: "HJ_PROFIT", name: "利润荷包", pool_type: "PROFIT", status: "ACTIVE" },
    ]} onFinanceEdit={onFinanceEdit} />);
    await settleFieldConfig();

    const timeInput = screen.getByLabelText("编辑资金明细时间 CF0037");
    expect(timeInput).toHaveValue("2026-10-15 10:20");
    expect(timeInput.closest(".order-finance-time-input")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("编辑资金明细金额 CF0037"), { target: { value: "88.50" } });
    expect(onFinanceEdit).toHaveBeenCalledWith("CF0037", { amount: "88.50" });

    const poolSelect = screen.getByRole("combobox", { name: "编辑资金明细资金账户 CF0037" });
    await userEvent.click(poolSelect);
    await userEvent.click(await screen.findByText("利润荷包", { selector: ".ant-select-item-option-content" }));
    expect(onFinanceEdit).toHaveBeenCalledWith("CF0037", { pool_id: 2 });
  });

  it("编辑资金明细保留当前停用账户且不允许选择其他停用账户", async () => {
    renderApp(<OrderDetailFinanceSection editing rows={[{
      key: "CF-STOP", flowNo: "CF-STOP", type: "回收成本", direction: "支出", amount: "100.00",
      occurredAt: "-", operator: "-", poolId: 2, poolName: "停用账户", note: "-",
    } as never]} orderExtras={[]} expenseCount={1} incomeCount={0} totalExpense="100.00" totalIncome="0"
      pools={[
        { id: 1, code: "A", name: "经营账户", pool_type: "INVEST", status: "ACTIVE" },
        { id: 2, code: "B", name: "停用账户", pool_type: "INVEST", status: "INACTIVE" },
        { id: 3, code: "C", name: "其他停用账户", pool_type: "INVEST", status: "INACTIVE" },
      ]} />);
    await userEvent.click(screen.getByRole("combobox", { name: "编辑资金明细资金账户 CF-STOP" }));
    const stopped = await screen.findByText("停用账户", { selector: ".ant-select-item-option-content" });
    expect(stopped.closest(".ant-select-item-option")).toHaveClass("ant-select-item-option-disabled");
    expect(screen.getByText("经营账户", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    expect(screen.queryByText("其他停用账户", { selector: ".ant-select-item-option-content" })).toBeNull();
  });

  it("没有事件记录时操作明细备注仍可编辑", async () => {
    const detail = {
      account,
      orders: [{ order_id: 34, order_no: "DG0034", order_type: "DG", created_at: "2026-10-15T10:19:00", operator: "admin", events: [] }],
      detail_view: {
        operation_rows: [],
        execution_rows: [{ key: "34-inventory-entry", order_id: 34, category: "INBOUND", action: "代挂入库", occurred_at: "2026-10-15T10:19:00", amount: "-", operator: "admin", note: "-", platform: "-" }],
        finance_rows: [],
        lifecycle: {},
        order_notes: "-",
        parties: [],
        extras: [],
      },
      finance_summary: { total_expense: "0.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;
    const onOrderEdit = vi.fn();

    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={34} loading={false} editing={account} onOrderEdit={onOrderEdit} employees={[]} />);
    await settleFieldConfig();

    const note = screen.getByLabelText("编辑执行备注 代挂入库");
    fireEvent.change(note, { target: { value: "补充入库说明" } });
    expect(onOrderEdit).toHaveBeenCalledWith(34, { note: "补充入库说明" });
  });

  it("没有运营事件时描述和作图内容仍可编辑", async () => {
    const detail = {
      account: { ...account, account_description: "旧描述", account_images: [] },
      orders: [{ order_id: 35, order_no: "DG0035", order_type: "DG", created_at: "2026-10-15T10:19:00", events: [] }],
      detail_view: {
        operation_rows: [
          { key: "consignment", action: "上架平台", content: "-", occurred_at: null, operator: "-", event_id: null },
          { key: "unlist", action: "下架平台", content: "-", occurred_at: null, operator: "-", event_id: null },
          { key: "description", action: "描述", content: "旧描述", occurred_at: null, operator: "-", event_id: null },
          { key: "images", action: "作图", content: "-", occurred_at: null, operator: "-", event_id: null },
        ],
        execution_rows: [],
        finance_rows: [],
        lifecycle: {},
        order_notes: "-",
        parties: [],
        extras: [],
      },
      finance_summary: { total_expense: "0.00", total_income: "0.00" },
    } as unknown as AccountExecutionDetail;
    const onProfileChange = vi.fn();

    renderApp(<OrderDetail row={account} detail={detail} contextOrderId={35} loading={false} editing={{ ...account, account_description: "旧描述", account_images: [] }} onProfileChange={onProfileChange} employees={[]} />);
    await settleFieldConfig();

    const description = screen.getByLabelText("编辑运营描述");
    fireEvent.change(description, { target: { value: "新描述" } });
    expect(onProfileChange).toHaveBeenCalledWith({ account_description: "新描述" });
    expect(screen.getByLabelText("上传作图")).toBeInTheDocument();
  });

  it("售出动作登记在来源订单时仍展示卖号交付", async () => {
    const detail = {
      account,
      orders: [{
        order_id: 32,
        order_no: "HS0032",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        latest_sale_event_id: 3202,
        events: [
          { id: 3201, event_type: "BUY", amount: "100.00", occurred_at: "2026-10-15T10:20:00" },
          { id: 3202, event_type: "SELL", amount: "200.00", occurred_at: "2026-10-15T11:20:00" },
        ],
      }],
      detail_view: { operation_rows: [], finance_rows: [], execution_rows: [], lifecycle: {}, order_notes: "-", parties: [], extras: [] },
      finance_summary: { total_expense: "100.00", total_income: "200.00" },
    } as unknown as AccountExecutionDetail;

    renderApp(<OrderDetail row={account} detail={detail} loading={false} editing={account} employees={[]} />);
    await settleFieldConfig();

    const deliverySection = document.querySelector(".order-detail__section--delivery") as HTMLElement;
    expect(within(deliverySection).getByText("买号交付")).toBeInTheDocument();
    expect(within(deliverySection).getByText("卖号交付")).toBeInTheDocument();
  });

  it("详情编辑态账号资料直接展示编辑控件", async () => {
    renderApp(<OrderDetail row={account} detail={{ orders: [] } as unknown as AccountExecutionDetail} loading={false} editing={account} employees={[]} />);
    await settleFieldConfig();
    const profile = document.querySelector(".order-detail__section--profile") as HTMLElement;
    expect(within(profile).getByLabelText("编辑游戏账号 / 产品")).toHaveValue("acc-1");
  });

  it("编辑态钱包实名可以下拉选择实名状态", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onProfileChange = vi.fn();
    const accountWithWalletRealname = { ...account, wallet_realname: "未注销" } as unknown as Account;

    renderApp(
      <OrderDetail
        row={accountWithWalletRealname}
        detail={{ orders: [] } as unknown as AccountExecutionDetail}
        loading={false}
        editing={accountWithWalletRealname}
        onProfileChange={onProfileChange}
        employees={[]}
      />,
    );
    await settleFieldConfig();

    const profile = document.querySelector(".order-detail__section--profile") as HTMLElement;
    const walletRealname = within(profile).getByRole("combobox", { name: "编辑钱包实名" });
    await user.click(walletRealname);
    await user.click(await screen.findByText("已注销", { selector: ".ant-select-item-option-content" }));

    expect(onProfileChange).toHaveBeenCalledWith({ wallet_realname: "已注销" });
  });

  it("FE-269：返点进入收入笔数，总收入取服务端 finance_summary", () => {
    const detail = {
      orders: [{
        order_id: 269,
        order_no: "HS-FE269",
        order_type: "HS",
        status: "DONE",
        created_at: "2026-11-02T10:00:00",
        events: [],
        rebates: [{
          id: 1,
          rebate_no: "HS-FE269-RB01",
          rebate_type: "BUY",
          channel: "买号返点",
          rate: "10",
          amount: "100.00",
          status: "OPEN",
          collected_on: "2026-11-02",
        }],
      }],
      finance_summary: {
        cashflow_income: "0.00",
        rebate_income: "100.00",
        total_income: "100.00",
        total_expense: "0.00",
        net_amount: "100.00",
      },
      detail_view: {
        operation_rows: [],
        execution_rows: [],
        finance_rows: [{ key: "RB01", flow_no: "RB01", type: "买号返点", direction: "收入", amount: "100.00", occurred_at: "2026-11-02T10:00:00", pool_name: "经营荷包", note: "-", operator: "admin" }],
        lifecycle: { removed_platform: "-", recovery_platform: "-", sale_platform: "-" },
        order_notes: "-",
        parties: [],
        extras: [],
      },
    } as unknown as AccountExecutionDetail;

    render(<OrderDetail row={account} detail={detail} loading={false} />);
    const panel = document.querySelector(".order-detail") as HTMLElement;
    const finance = panel.querySelector(".order-detail__section--finance") as HTMLElement;
    expect(within(finance).getAllByText("1 笔").length).toBeGreaterThanOrEqual(1);
    const summary = finance.querySelector(".order-finance-summary") as HTMLElement;
    expect(within(summary).getByText("总收入").parentElement).toHaveTextContent("100.00");
  });

  it("总额度只认后端 finance_summary，不按明细行相加", () => {
    // 明细里有一笔 500.00 收入，但后端合计是 123.45：卡片必须显示 123.45。
    const detail = {
      orders: [{
        order_id: 271,
        order_no: "HS-FE271",
        order_type: "HS",
        status: "DONE",
        created_at: "2026-11-02T10:00:00",
        events: [],
        cashflows: [{
          flow_no: "SR-FE271",
          occurred_on: "2026-11-02",
          occurred_at: "2026-11-02T10:00:00",
          direction: "IN",
          category: "OTHER",
          amount: "500.00",
          operator: "admin",
        }],
        rebates: [],
      }],
      finance_summary: {
        cashflow_income: "123.45",
        rebate_income: "0.00",
        total_income: "123.45",
        total_expense: "67.89",
        net_amount: "55.56",
      },
    } as unknown as AccountExecutionDetail;

    render(<OrderDetail row={account} detail={detail} loading={false} />);
    const panel = document.querySelector(".order-detail") as HTMLElement;
    const summary = panel.querySelector(".order-finance-summary") as HTMLElement;
    expect(within(summary).getByText("总收入").parentElement).toHaveTextContent("123.45");
    expect(within(summary).getByText("总支出").parentElement).toHaveTextContent("67.89");
  });

  it("无寄售平台的初始代挂单只显示未登记的运营动作", () => {
    const consignmentAccount = { ...account, inventory_type: "CONSIGNMENT" } as unknown as Account;
    const detail = {
      orders: [{
        order_id: 129,
        order_no: "DG-FE129-BASE",
        order_type: "DG",
        status: "ACTIVE",
        created_at: "2026-11-02T10:00:00",
        trade_date: "2026-11-02",
        events: [],
        extra_values: {},
      }],
    } as unknown as AccountExecutionDetail;

    render(<OrderDetail row={consignmentAccount} detail={detail} loading={false} />);

    const operation = document.querySelector(".order-detail__section--operation") as HTMLElement;
    expect(within(operation).getByText("上架平台")).toBeInTheDocument();
    expect(within(operation).queryByText("寄售中")).toBeNull();
  });

  it("明确平台的代挂动作在运营信息中展示平台", () => {
    const consignmentAccount = { ...account, inventory_type: "CONSIGNMENT" } as unknown as Account;
    const detail = {
      orders: [{
        order_id: 130,
        order_no: "DG-FE129-LISTED",
        order_type: "DG",
        status: "ACTIVE",
        created_at: "2026-11-02T10:00:00",
        trade_date: "2026-11-02",
        events: [{
          id: 1301,
          event_type: "OPERATE",
          operation_type: "CONSIGNMENT",
          form_extra: { consignment_platforms: ["盼之"], listed_at: "2026-11-02T10:05" },
        }],
      }],
      detail_view: {
        operation_rows: [{ key: "consignment", action: "上架平台", content: "盼之", occurred_at: "2026-11-02T10:05", operator: "admin", event_id: 1301 }, { key: "unlist", action: "下架平台", content: "-", occurred_at: null, operator: "-", event_id: null }, { key: "description", action: "描述", content: "-", occurred_at: null, operator: "-", event_id: null }, { key: "images", action: "作图", content: "-", occurred_at: null, operator: "-", event_id: null }],
        execution_rows: [],
        finance_rows: [],
        lifecycle: { removed_platform: "-", recovery_platform: "-", sale_platform: "-" },
        order_notes: "-",
        parties: [],
        extras: [],
      },
    } as unknown as AccountExecutionDetail;

    render(<OrderDetail row={consignmentAccount} detail={detail} loading={false} />);

    const operation = document.querySelector(".order-detail__section--operation") as HTMLElement;
    expect(within(operation).getByText("盼之")).toBeInTheDocument();
    expect(within(operation).queryByText("寄售中")).toBeNull();
  });
});

// —— 原 OrderDetailImageGallery.test.tsx ——
// 同属订单详情编辑链路，合并后保留图片替换/追加边界，同时减少一次 jsdom+React 启动。
describe("OrderDetailImageGallery", () => {
  it("订单详情放大时携带图片版本读取对应原图", async () => {
    const load = vi.spyOn(ordersApi, "executionImage").mockResolvedValue("data:image/png;base64,original");
    const previewAccount = { ...account, secondary_images: ["data:image/jpeg;base64,thumbnail"] };
    const detail = { account: previewAccount, image_previews: true, image_versions: { secondary_images: ["version-1"] },
      orders: [{ order_id: 35, order_no: "HS-35", order_type: "HS", events: [] }] } as unknown as AccountExecutionDetail;
    renderLight(<OrderDetail row={previewAccount} detail={detail} contextOrderId={35} loading={false} />, { user: "admin" });
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByAltText("二次图片 1"));
    await waitFor(() => expect(load).toHaveBeenCalledWith(35, "secondary_images", 0, "version-1"));
    await waitFor(() => expect(document.querySelector(".ant-image-preview-img")).toHaveAttribute("src", "data:image/png;base64,original"));
  });

});
