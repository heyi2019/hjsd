import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Form } from "antd";
import { useRef, useState, type Key } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { accounts, setupInventoryWrite } from "@fixtures/inventoryWriteSetup";
import { InventoryPanel } from "@/business/inventory/InventoryPanel";
import { RecoverySaleModal, PickupSaleModal, ConsignmentSaleModal } from "@/business/shared/sale";
import { InventoryRebateModal } from "@/business/shared/rebate";
import { OrderConsignmentModal } from "@/business/shared/operations/consignment";
import { OrderDetailDeliverySection } from "@/business/shared/order-detail/OrderDetailDeliverySection";
import { OrderDetailProfileSection } from "@/business/shared/order-detail/OrderDetailProfileSection";
import { useOrderDetailEditor } from "@/business/shared/order-detail/editing/use-order-detail-editor";
import { useInventoryList } from "@/business/inventory/InventoryPanel/useInventoryList";
import { useExecutionCache } from "@/business/inventory/InventoryPanel/useExecutionCache";
import { useInventoryActions } from "@/business/inventory/InventoryPanel/useInventoryActions";
import type { InventoryOrderRow } from "@/business/inventory/InventoryPanel/types";
import { FieldConfigScope } from "@/shared/forms/ConfigurableField";
import { BusinessRegistrationForm } from "@/shared/ui";
import { appMessage } from "@/shared/ui/appFeedback";

import type { Account } from "@/shared/api/types/accounts";
import { customersApi } from "@/shared/api/customers.api";
import { installmentsApi } from "@/shared/api/installments.api";
import { orderFormFieldsApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { rebatesApi } from "@/shared/api/rebates.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { resolveMock } from "@fixtures/mock-api";
import { allFormFields, seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { inventoryLedgerResponse } from "@fixtures/api-responses";
vi.mock("@/shared/api/cashflows.api");
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
vi.mock("@/shared/api/stocks.api");

async function loadStandaloneActionExecution(account: Account, isActive: () => boolean) {
  if (account.source_order_id == null) return null;
  const detail = await ordersApi.executionDetail(account.source_order_id);
  return isActive() ? { detail, isCurrent: isActive } : null;
}

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => { ui = setupInventoryWrite(); });

// 原 InventoryConsignmentModal.test.tsx：只读 executionDetail，「已上架记录」的平台名来源（L234）
describe("InventoryConsignmentModal 已上架记录平台展示（L234）", () => {
  const consignAccount = {
    id: 1,
    source_order_id: 22,
    source_order_no: "DG-2026-0003",
    game_account: "acc-3",
    game_type: "手游",
    status: "IN_STOCK",
  } as unknown as Account;

  function renderConsignment() {
    return renderLight(
      <OrderConsignmentModal account={consignAccount} onClose={vi.fn()} onCreated={vi.fn()} />,
      { user: "admin" },
    );
  }

  it("上架记录读取失败后可在弹窗内重试", async () => {
    vi.mocked(ordersApi.executionDetail).mockRejectedValueOnce(new Error("上架记录读取失败"));
    vi.mocked(ordersApi.executionDetail).mockResolvedValueOnce({
      account: { id: 1, status: "WAITING" },
      orders: [{ order_id: 22, status: "ACTIVE", events: [], active_consignments: [] }],
    } as never);
    renderConsignment();
    expect(await screen.findByText(/上架记录读取失败/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "寄售平台" })).toBeDisabled();
    await ui.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.queryByText(/上架记录读取失败/)).not.toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "寄售平台" })).toBeEnabled();
    expect(ordersApi.executionDetail).toHaveBeenCalledTimes(2);
  });

  it("后端未返回上架状态时提示重试，不能当作空记录继续上架", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValueOnce({
      account: { id: 1, status: "WAITING" }, orders: [{ order_id: 22, status: "ACTIVE", events: [] }],
    } as never);
    renderConsignment();
    expect(await screen.findByText(/上架状态不可用/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "寄售平台" })).toBeDisabled();
  });

  it("原订单寄售事件的已上架记录展示平台名", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [
        {
          order_id: 22,
          order_type: "HS",
          status: "ACTIVE",
          trade_date: "2026-10-12",
          created_at: "2026-10-12T09:10:00",
          active_consignments: [{ event_id: 901, platform: "盼之", price: null, listed_at: "2026-10-12T09:10:00" }],
          events: [{
            id: 901,
            event_type: "OPERATE",
            operation_type: "CONSIGNMENT",
            form_extra: { consignment_platforms: ["盼之"], listed_at: "2026-10-12T09:10:00" },
          }],
        },
      ],
    } as never);

    renderConsignment();

    expect(await screen.findByText("盼之")).toBeInTheDocument();
  });

  it("已上架平台不再出现在新增上架选项", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({ account: { id: 1, status: "WAITING" }, orders: [{
      order_id: 22, status: "ACTIVE", active_consignments: [{ event_id: 901, platform: "盼之", price: null, listed_at: "2026-10-12T09:10:00" }], events: [{ id: 901, event_type: "OPERATE", operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["盼之"] } }],
    }] } as never);
    renderConsignment();
    await screen.findByText("盼之");
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "寄售平台" }).closest(".ant-select-selector")!);
    expect(await screen.findByText("千寻", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    expect(screen.queryByText("盼之", { selector: ".ant-select-item-option-content" })).toBeNull();
  });

  it("平台下架后可重新选择上架", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({ account: { id: 1, status: "WAITING" }, orders: [{
      order_id: 22, status: "ACTIVE", events: [
        { id: 901, event_type: "OPERATE", operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["盼之"] } },
        { id: 902, event_type: "OPERATE", operation_type: "UNLIST", form_extra: { consignment_event_id: 901, consignment_platforms: ["盼之"], platform_unlist_scope: "PLATFORM" } },
      ],
      active_consignments: [],
    }] } as never);
    renderConsignment();
    await screen.findByText("暂无上架记录");
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "寄售平台" }).closest(".ant-select-selector")!);
    expect(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("寄售平台从原订单寄售事件读取", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [
        {
          order_id: 22,
          order_type: "HS",
          status: "ACTIVE",
          trade_date: "2026-10-12",
          created_at: "2026-10-12T09:10:00",
          active_consignments: [{ event_id: 902, platform: "寄售平台A", price: null, listed_at: "2026-10-12T09:10:00" }],
          events: [{
            id: 902,
            event_type: "OPERATE",
            operation_type: "CONSIGNMENT",
            form_extra: { consignment_platforms: ["寄售平台A"], listed_at: "2026-10-12T09:10:00" },
          }],
        },
      ],
    } as never);

    renderConsignment();

    expect(await screen.findByText("寄售平台A")).toBeInTheDocument();
  });

  it("已上架记录限制为弹窗内滚动，不继续撑高寄售弹窗", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [{
        order_id: 22,
        order_no: "DG-2026-0003",
        order_type: "DG",
        status: "ACTIVE",
        trade_date: "2026-10-12",
        created_at: "2026-10-12T09:10:00",
        active_consignments: Array.from({ length: 12 }, (_, index) => ({ event_id: 920 + index, platform: `寄售平台${index + 1}`, price: null, listed_at: `2026-10-${String(index + 1).padStart(2, "0")}T09:10:00` })),
        events: Array.from({ length: 12 }, (_, index) => ({
          id: 920 + index,
          event_type: "OPERATE",
          operation_type: "CONSIGNMENT",
          form_extra: { consignment_platforms: [`寄售平台${index + 1}`], listed_at: `2026-10-${String(index + 1).padStart(2, "0")}T09:10:00` },
        })),
      }],
    } as never);

    renderConsignment();

    await screen.findByText("寄售平台12");
    const recordsBody = document.querySelector<HTMLElement>(".inventory-consignment-records-table .ant-table-body");
    expect(recordsBody).toHaveStyle({ maxHeight: "180px", overflowY: "scroll" });
  });

  it("没有足够明细时不预留固定滚动高度", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [{
        order_id: 22,
        order_no: "DG-2026-0003",
        order_type: "DG",
        status: "ACTIVE",
        trade_date: "2026-10-12",
        created_at: "2026-10-12T09:10:00",
        active_consignments: [],
        events: [],
      }],
    } as never);

    renderConsignment();

    await screen.findByText("暂无上架记录");
    expect(document.querySelector(".inventory-consignment-records-table .ant-table-body")).toBeNull();
  });

  it("没有上架明细时使用共享紧凑空态", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [{
        order_id: 22,
        order_no: "DG-2026-0003",
        order_type: "DG",
        status: "ACTIVE",
        trade_date: "2026-10-12",
        created_at: "2026-10-12T09:10:00",
        active_consignments: [],
        events: [],
      }],
    } as never);

    renderConsignment();

    await screen.findByText("暂无上架记录");
    expect(document.querySelector(".inventory-consignment-records-table .ant-table-body")).toBeNull();
    expect(document.querySelector(".inventory-consignment-records-table .ui-datatable__empty")).toBeTruthy();
  });

  it("账号处于 VOID 时，已上架记录为空且无旧平台残留", async () => {
    vi.mocked(ordersApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "VOID" },
      orders: [
        {
          order_id: 22,
          order_type: "DG",
          status: "ACTIVE",
          trade_date: "2026-10-12",
          created_at: "2026-10-12T09:10:00",
          counterparties: [{ id: 11, display_name: "寄售平台A", role: "PLATFORM" }],
        },
      ],
    } as never);

    renderConsignment();

    expect(await screen.findByText("已上架记录")).toBeInTheDocument();
    // VOID 账号按源码逻辑清空列表；不得渲染平台名
    await waitFor(() => expect(screen.queryByText("寄售平台A")).not.toBeInTheDocument());
  });
});

it("订单账号信息按草稿顺序展示业务操作人并标识未知员工", async () => {
  renderLight(<OrderDetailProfileSection meta={{ sourceOrderNo: "HS-2026-0001" } as never}
    detail={{ orders: [{ order_id: 21, order_no: "HS-2026-0001", order_type: "HS" }] } as never}
    account={accounts[0] as Account}
    employees={[{ id: 1, username: "admin", display_name: "管理员", is_active: true }, { id: 2, username: "bob", display_name: "小红", is_active: true }]}
    orderDrafts={{ 21: { order_id: 21, occurred_at: "", note: "", form_extra: { business_responsible_ids: [2, 999, 1] } } }} />);
  expect(await screen.findByText("小红、未知员工、管理员")).toBeInTheDocument();
});

it("订单详情编辑账号自定义字段时保留配置的类型", async () => {
  vi.mocked(orderFormFieldsApi.list).mockResolvedValue([
    ...allFormFields(),
    { id: 9001, order_type_code: "HS", field_key: "rank", label: "等级", field_type: "NUMBER", options: [], required: false, is_active: true, sort_order: 90, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT" },
    { id: 9002, order_type_code: "HS", field_key: "verified", label: "已核验", field_type: "BOOLEAN", options: [], required: false, is_active: true, sort_order: 91, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT" },
    { id: 9003, order_type_code: "HS", field_key: "labels", label: "标签", field_type: "MULTI_SELECT", options: [{ value: "A", label: "甲" }, { value: "B", label: "乙" }], required: false, is_active: true, sort_order: 92, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT" },
    { id: 9004, order_type_code: "HS", field_key: "region", label: "地区", field_type: "SELECT", options: [{ value: "N", label: "北区" }, { value: "S", label: "南区" }], required: false, is_active: true, sort_order: 93, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT" },
    { id: 9005, order_type_code: "HS", field_key: "joined_on", label: "登记日期", field_type: "DATE", options: [], required: false, is_active: true, sort_order: 94, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT" },
  ] as never);
  vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
  function Harness() {
    const [account, setAccount] = useState({ ...accounts[0], extra_values: { rank: 3, verified: true, labels: ["A"], region: "N", joined_on: "2026-11-01" } } as Account);
    return <><OrderDetailProfileSection meta={{ sourceOrderNo: "HS-2026-0001" } as never}
      detail={{ orders: [{ order_no: "HS-2026-0001", order_type: "HS" }] } as never}
      account={account} editing onProfileChange={(changes) => setAccount((current) => ({ ...current, ...changes }))} />
      <output data-testid="profile-extra">{JSON.stringify(account.extra_values)}</output></>;
  }
  renderLight(<Harness />);
  const rank = await screen.findByRole("spinbutton", { name: "编辑等级" });
  await ui.clear(rank);
  await ui.type(rank, "12");
  fireEvent.blur(rank);
  await ui.click(screen.getByRole("switch", { name: "编辑已核验" }));
  await ui.click(screen.getByRole("combobox", { name: "编辑标签" }));
  await ui.click(await screen.findByText("乙", { selector: ".ant-select-item-option-content" }));
  await ui.click(screen.getByRole("combobox", { name: "编辑地区" }));
  await ui.click(await screen.findByText("南区", { selector: ".ant-select-item-option-content" }));
  expect(screen.getByLabelText("编辑登记日期")).toHaveValue("2026-11-01");
  await waitFor(() => expect(JSON.parse(screen.getByTestId("profile-extra").textContent || "{}"))
    .toEqual({ rank: 12, verified: false, labels: ["A", "B"], region: "S", joined_on: "2026-11-01" }));
});

it("订单详情显示账号自定义选项和已删除字段的历史值", async () => {
  const creationFields = [
    ...allFormFields(),
    { id: 9001, order_type_code: "HS", field_key: "region", label: "地区", field_type: "SELECT", options: [{ value: "N", label: "北区" }], required: false, is_active: true, sort_order: 90, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT" },
    { id: 9002, order_type_code: "HS", field_key: "labels", label: "标签", field_type: "MULTI_SELECT", options: [{ value: "A", label: "甲" }, { value: "B", label: "乙" }], required: false, is_active: true, sort_order: 91, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT" },
    { id: 9003, order_type_code: "HS", field_key: "old_note", label: "旧备注", field_type: "TEXT", options: [], required: false, is_active: false, sort_order: 92, locked: false, is_custom: true, section: "ACCOUNT_PRODUCT" },
  ];
  vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => scope === "INVEDIT" ? [{
    id: 9004, order_type_code: "INVEDIT", field_key: "inventory_grade", label: "库存评级", field_type: "SELECT",
    options: [{ value: "TOP", label: "特级" }], required: false, is_active: true, sort_order: 1, locked: false, is_custom: true, section: "EXTRA",
  }] : creationFields);
  vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
  const props = {
    meta: { sourceOrderNo: "HS-2026-0001" } as never,
    detail: { orders: [{ order_no: "HS-2026-0001", order_type: "HS" }] } as never,
    account: { ...accounts[0], extra_values: { region: "N", labels: ["A", "B"], old_note: "停用历史", removed_note: "删除历史", inventory_grade: "TOP" } } as Account,
  };
  const view = renderLight(<OrderDetailProfileSection {...props} />);
  expect(await screen.findByText("北区")).toBeInTheDocument();
  expect(screen.getByText("甲、乙")).toBeInTheDocument();
  expect(screen.getByText("旧备注（已停用）")).toBeInTheDocument();
  expect(screen.getByText("停用历史")).toBeInTheDocument();
  expect(screen.getByText("removed_note（已删除）")).toBeInTheDocument();
  expect(screen.getByText("删除历史")).toBeInTheDocument();
  expect(screen.getByText("库存评级")).toBeInTheDocument();
  expect(screen.getByText("特级")).toBeInTheDocument();
  view.rerender(<OrderDetailProfileSection {...props} editing />);
  expect(screen.queryByRole("textbox", { name: "编辑旧备注" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "编辑removed_note" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "编辑库存评级" })).toBeNull();
  expect(screen.getByText("停用历史")).toBeInTheDocument();
  expect(screen.getByText("删除历史")).toBeInTheDocument();
});

// —— 原 OrderDetailDeliverySection.test.tsx ——
// 订单详情「交付明细」区块：只读 props + 字段定义，无页面级挂载。
describe("OrderDetailDeliverySection", () => {
  beforeEach(() => {
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([]);
  });
  it("交付自定义字段展示配置的选项名称", async () => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => scope === "HS" ? [{
      id: 9900, order_type_code: "HS", field_key: "delivery_tags", label: "交付标签", field_type: "MULTI_SELECT",
      options: [{ value: "A", label: "甲" }, { value: "B", label: "乙" }, { value: "C", label: "丙" }], required: false, is_active: true,
      sort_order: 1, locked: false, is_custom: true, section: "DELIVER",
    }, {
      id: 9901, order_type_code: "HS", field_key: "old_delivery", label: "旧交付记录", field_type: "TEXT",
      options: [], required: false, is_active: false, sort_order: 2, locked: false, is_custom: true, section: "DELIVER",
    }] : []);
    const props = {
      meta: { sourceOrderNo: "HS-0001" } as never,
      detail: { orders: [{ order_id: 21, order_no: "HS-0001", order_type: "HS", extra_values: { delivery_tags: ["A", "B"], old_delivery: "历史交付" }, events: [] }] } as never,
    };
    const view = renderLight(<OrderDetailDeliverySection {...props} />);
    expect(await screen.findByText("交付标签")).toBeInTheDocument();
    expect(screen.getByText("甲、乙")).toBeInTheDocument();
    const onOrderExtraChange = vi.fn();
    view.rerender(<OrderDetailDeliverySection {...props} editing onOrderExtraChange={onOrderExtraChange} />);
    expect(screen.queryByRole("textbox", { name: "编辑旧交付记录" })).toBeNull();
    expect(screen.getByText("历史交付")).toBeInTheDocument();
    await ui.click(screen.getByRole("combobox", { name: "编辑交付标签" }));
    await ui.click(await screen.findByText("丙", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(21, "delivery_tags", ["A", "B", "C"]);
  });
  it("FE-265：订单详情回显交易平台、中介类型和包赔类型", async () => {
    const detail = {
      orders: [{
        order_id: 21,
        order_no: "HS-FE265",
        order_type: "HS",
        created_at: "2026-11-02T10:00:00",
        extra_values: {
          intermediary_platform: "其他",
          intermediary_platform_other: "星河平台",
          intermediary_type: "包赔",
          compensation_type: "续保",
        },
        events: [],
      }],
    };

    const { rerender } = renderLight(
      <OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE265" } as never} detail={detail as never} />,
      { user: "admin" },
    );

    await waitFor(() => {
      expect(screen.getByText("星河平台")).toBeInTheDocument();
      expect(screen.getByText("包赔")).toBeInTheDocument();
      expect(screen.getByText("续保")).toBeInTheDocument();
    });
    const onOrderExtraChange = vi.fn();
    rerender(<OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE265" } as never}
      detail={detail as never} editing onOrderExtraChange={onOrderExtraChange} />);
    const other = await screen.findByLabelText("编辑其他平台");
    expect(other).toHaveValue("星河平台");
    fireEvent.change(other, { target: { value: "新平台" } });
    expect(onOrderExtraChange).toHaveBeenCalledWith(21, "intermediary_platform_other", "新平台");
    await ui.click(screen.getByRole("combobox", { name: "编辑交易平台" }));
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(21, "intermediary_platform_other", null);
  });

  it("编辑态交易平台、中介类型和包赔类型可以下拉选择", async () => {
    vi.mocked(orderFormFieldsApi.list).mockResolvedValueOnce([
      {
        id: 1, order_type_code: "HS", field_key: "intermediary_platform", label: "交易平台", field_type: "SELECT",
        options: [{ value: "盼之", label: "盼之" }, { value: "其他", label: "其他" }], required: false, is_active: true, sort_order: 1, locked: false, is_custom: false,
      },
      {
        id: 2, order_type_code: "HS", field_key: "intermediary_type", label: "中介类型", field_type: "SELECT",
        options: [{ value: "普中", label: "普中" }, { value: "包赔", label: "包赔" }], required: false, is_active: true, sort_order: 2, locked: false, is_custom: false,
      },
      {
        id: 3, order_type_code: "HS", field_key: "compensation_type", label: "包赔类型", field_type: "SELECT",
        options: [{ value: "首保", label: "首保" }, { value: "续保", label: "续保" }], required: false, is_active: true, sort_order: 3, locked: false, is_custom: false,
      },
    ] as never);
    const onOrderExtraChange = vi.fn();
    const detail = {
      orders: [{
        order_id: 25,
        order_no: "HS-FE268",
        order_type: "HS",
        created_at: "2026-11-02T10:00:00",
        extra_values: { intermediary_platform: "盼之", intermediary_type: "普中", compensation_type: "首保" },
        events: [],
      }],
    };

    renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "HS-FE268" } as never}
        detail={detail as never}
        editing
        onOrderExtraChange={onOrderExtraChange}
      />,
      { user: "admin" },
    );

    const platform = await screen.findByRole("combobox", { name: "编辑交易平台" });
    await ui.click(platform);
    await ui.click(await screen.findByText("其他", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(25, "intermediary_platform", "其他");

    const intermediaryType = screen.getByRole("combobox", { name: "编辑中介类型" });
    await ui.click(intermediaryType);
    await ui.click(await screen.findByText("包赔", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(25, "intermediary_type", "包赔");

    const compensationType = screen.getByRole("combobox", { name: "编辑包赔类型" });
    await ui.click(compensationType);
    await ui.click(await screen.findByText("续保", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(25, "compensation_type", "续保");
  });

  it("编辑态交付操作人选择器保持可读宽度", async () => {
    renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "HS-FE269" } as never}
        detail={{
          orders: [{ order_id: 26, order_no: "HS-FE269", order_type: "HS", created_at: "2026-11-02T10:00:00", extra_values: {}, events: [] }],
        } as never}
        editing
        employees={[{ id: 7, username: "lisi", display_name: "李三（三三）", is_active: true }]}
      />,
      { user: "admin" },
    );

    const responsible = await waitFor(() => {
    const select = document.querySelector<HTMLElement>('.ant-select[aria-label="编辑交付操作人"]');
      expect(select).toBeInTheDocument();
      return select as HTMLElement;
    });
    expect(responsible).toHaveClass("order-detail__delivery-responsible");

    const searchInput = responsible.querySelector<HTMLInputElement>(".ant-select-selection-search-input");
    expect(searchInput).toBeInTheDocument();
    await ui.click(searchInput!);
    await ui.type(searchInput!, "李");
    expect(await screen.findByText("李三（三三）", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("FE-266：交付操作人回显员工姓名，未加载时不泄露原始 ID", async () => {
    const detail = {
      orders: [{
        order_id: 22,
        order_no: "HS-FE266",
        order_type: "HS",
        created_at: "2026-11-02T10:00:00",
        extra_values: { delivery_responsible_ids: [7] },
        events: [],
      }],
    };

    const { unmount } = renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "HS-FE266" } as never}
        detail={detail as never}
        employees={[{ id: 7, username: "lisi", display_name: "李三（三三）", is_active: true }]}
      />,
      { user: "admin" },
    );

    await waitFor(() => expect(screen.getByText("李三（三三）")).toBeInTheDocument());
    expect(screen.queryByText("7")).not.toBeInTheDocument();
    unmount();

    renderLight(
      <OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE266" } as never} detail={detail as never} />,
      { user: "admin" },
    );
    await waitFor(() => expect(screen.getByText("操作人信息加载中")).toBeInTheDocument());
    expect(screen.queryByText("7")).not.toBeInTheDocument();
  });

  it("FE-267：同一订单买号和卖号交付独立展示并编辑", async () => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => scope === "SALEREC" ? [{
      id: 9901, order_type_code: "SALEREC", field_key: "sale_receipt", label: "卖号凭据", field_type: "TEXT",
      options: [], required: false, is_active: true, sort_order: 1, locked: false, is_custom: true, section: "DELIVER",
    }] as never : []);
    const detail = {
      orders: [
        {
          order_id: 23,
          order_no: "HS-FE267",
          order_type: "HS",
          created_at: "2026-11-02T10:00:00",
          latest_sale_event_id: 1,
          extra_values: {
            bound_phone: "13800000001", bound_phone_owner: "买号绑定人", intermediary_platform: "盼之",
            sell_bound_phone: "13800000002", sell_bound_phone_owner: "卖号绑定人", sell_intermediary_platform: "其他",
            sell_intermediary_platform_other: "卖号平台",
          },
          events: [{ event_type: "SELL", id: 1, amount: "1", occurred_on: "2026-11-02", form_extra: { sale_mode: "FULL", sale_receipt: "原卖号凭据" } }],
        },
      ],
    };

    const { rerender } = renderLight(
      <OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE267" } as never} detail={detail as never} account={{ bound_phone: "13800000002" } as never} />,
      { user: "admin" },
    );

    await waitFor(() => {
      expect(screen.getByText("买号绑定人")).toBeInTheDocument();
      expect(screen.getByText("卖号绑定人")).toBeInTheDocument();
      expect(screen.getByText("13800000001")).toBeInTheDocument();
      expect(screen.getByText("13800000002")).toBeInTheDocument();
      expect(screen.getByText("卖号平台")).toBeInTheDocument();
      expect(screen.getByText("原卖号凭据")).toBeInTheDocument();
    });
    const onOrderExtraChange = vi.fn();
    const onProfileChange = vi.fn();
    const onEventEdit = vi.fn();
    rerender(<OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE267" } as never} detail={detail as never}
      account={{ bound_phone: "13800000002" } as never} editing onOrderExtraChange={onOrderExtraChange} onProfileChange={onProfileChange} onEventEdit={onEventEdit} />);
    const groups = document.querySelectorAll<HTMLElement>(".order-detail__meta-group");
    expect(groups).toHaveLength(2);
    expect(within(groups[0]).getByLabelText("编辑换绑手机号")).toHaveValue("13800000001");
    expect(within(groups[1]).getByLabelText("编辑换绑手机号")).toHaveValue("13800000002");
    fireEvent.change(within(groups[0]).getByLabelText("编辑换绑手机号"), { target: { value: "13700000001" } });
    expect(onOrderExtraChange).toHaveBeenCalledWith(23, "bound_phone", "13700000001");
    expect(onProfileChange).not.toHaveBeenCalled();
    fireEvent.change(within(groups[1]).getByLabelText("编辑换绑手机号"), { target: { value: "13900000002" } });
    expect(onOrderExtraChange).toHaveBeenCalledWith(23, "sell_bound_phone", "13900000002");
    expect(onProfileChange).toHaveBeenCalledWith({ bound_phone: "13900000002" });
    fireEvent.change(within(groups[0]).getByLabelText("编辑手机号绑定人"), { target: { value: "新买号绑定人" } });
    fireEvent.change(within(groups[1]).getByLabelText("编辑手机号绑定人"), { target: { value: "新卖号绑定人" } });
    expect(onOrderExtraChange).toHaveBeenCalledWith(23, "bound_phone_owner", "新买号绑定人");
    expect(onOrderExtraChange).toHaveBeenCalledWith(23, "sell_bound_phone_owner", "新卖号绑定人");
    await ui.click(within(groups[1]).getByRole("combobox", { name: "编辑交易平台" }));
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    expect(onOrderExtraChange).toHaveBeenCalledWith(23, "sell_intermediary_platform", "盼之");
    expect(onOrderExtraChange).toHaveBeenCalledWith(23, "sell_intermediary_platform_other", null);
    fireEvent.change(within(groups[1]).getByLabelText("编辑卖号凭据"), { target: { value: "新卖号凭据" } });
    expect(onEventEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), { form_extra: { sale_mode: "FULL", sale_receipt: "新卖号凭据" } });
  });

  it("FE-268：仅有代挂订单时卖号交付仍展示交付表格", async () => {
    const detail = {
      orders: [{
        order_id: 25,
        order_no: "DG-FE268",
        order_type: "DG",
        created_at: "2026-11-02T10:00:00",
        extra_values: {
          intermediary_platform: "盼之",
          intermediary_type: "普中",
          compensation_type: "首保",
          delivery_responsible_ids: [1],
        },
        events: [],
      }],
    };

    renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "DG-FE268" } as never}
        detail={detail as never}
        employees={[{ id: 1, username: "admin", display_name: "管理员", is_active: true }]}
      />,
      { user: "admin" },
    );

    await waitFor(() => expect(screen.getAllByText("盼之").length).toBeGreaterThan(0));
  });
});

// —— 原 InventoryPanel.sale.test.tsx ——
// 售出、写入和详情编辑共享同一页面依赖与初始化，合并后避免重复启动重型库存页面。
describe("库存售出流程", () => {
beforeEach(() => {
  seedOrderFormFields();
});

it("上一单售出完成后，不清空或关闭新订单的表单", async () => {
  let finish!: (value: Awaited<ReturnType<typeof ordersApi.stockSale>>) => void;
  vi.mocked(ordersApi.stockSale).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const { rerender } = renderLight(<RecoverySaleModal account={accounts[0] as Account} onClose={onClose} onCreated={onCreated} />, { user: "admin" });
  await ui.type(await screen.findByLabelText("售出金额"), "350");
  await ui.click(screen.getByLabelText("资金账户"));
  await ui.click(await screen.findByText(/利润池/));
  await ui.click(screen.getByRole("button", { name: /确认售出/ }));
  await waitFor(() => expect(ordersApi.stockSale).toHaveBeenCalledTimes(1));
  rerender(<RecoverySaleModal account={accounts[1] as Account} onClose={onClose} onCreated={onCreated} />);
  await waitFor(() => expect(screen.getByText("acc-2")).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("售出金额"), { target: { value: "200" } });
  await act(async () => finish({} as never));
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText("售出金额")).toHaveValue("200");
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 1, source_order_id: 21 }));
});

it.each([RecoverySaleModal, PickupSaleModal, ConsignmentSaleModal])("已选售出操作人时无需等待人员重查，提交期间防止重复操作", async (SaleModal) => {
  vi.mocked(employeesApi.list).mockResolvedValueOnce([{ id: 2, username: "bob", display_name: "小红", is_active: true }]);
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<SaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  const amountLabel = SaleModal === ConsignmentSaleModal ? "利润" : "售出金额";
  await saleUi.type(await screen.findByLabelText(amountLabel), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  await waitFor(() => expect(employeesApi.list).toHaveBeenCalledTimes(1));
  await saleUi.click(screen.getByLabelText("售出操作人"));
  await saleUi.click(await screen.findByText("小红", { selector: ".ant-select-item-option-content" }));
  await saleUi.click(screen.getByLabelText("交付操作人"));
  const employeeOptions = screen.getAllByText("小红", { selector: ".ant-select-item-option-content" });
  await saleUi.click(employeeOptions[employeeOptions.length - 1]);
  const listCallsBeforeSubmit = vi.mocked(employeesApi.list).mock.calls.length;
  vi.mocked(employeesApi.list).mockReturnValue(new Promise(() => {}));
  vi.mocked(ordersApi.stockSale).mockReturnValue(new Promise(() => {}));
  const form = screen.getByLabelText(amountLabel).closest("form")!;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /确认售出/ })); });
  await waitFor(() => expect(ordersApi.stockSale).toHaveBeenCalledTimes(1));
  await act(async () => { fireEvent.submit(form); });
  expect(employeesApi.list).toHaveBeenCalledTimes(listCallsBeforeSubmit);
  expect(screen.getByRole("button", { name: /确认售出/ })).toHaveClass("ant-btn-loading");
  expect(ordersApi.stockSale).toHaveBeenCalledTimes(1);
});

it("不填写客户时仍可售出", async () => {
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  await saleUi.type(await screen.findByLabelText("售出金额"), "350");
  await saleUi.click(screen.getByLabelText("交易平台"));
  await saleUi.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
  await waitFor(() => expect(ordersApi.stockSale).toHaveBeenCalledWith(21, expect.objectContaining({
    amount: "350", delivery_form_extra: expect.objectContaining({ intermediary_platform: "盼之", intermediary_platform_other: null }),
  })));
  expect(customersApi.create).not.toHaveBeenCalled();
});

it("填写客户时无需预先加载完整客户名单", async () => {
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
  await screen.findByText("买家信息");
  await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
  await saleUi.type(screen.getByLabelText("售出金额"), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
  await waitFor(() => expect(ordersApi.stockSale).toHaveBeenCalledWith(21, expect.objectContaining({ customer_input: expect.objectContaining({ display_name: "买家A", role: "BUYER" }) })));
  expect(customersApi.page).not.toHaveBeenCalled();
});

it("售出时把新买家关联到来源单而非新建订单", async () => {
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  resolveMock(vi.mocked(customersApi.page), { items: [], total: 0, limit: 500, offset: 0 });
  resolveMock(vi.mocked(customersApi.create), {
    customer: { id: 8, customer_no: "C0008", display_name: "新买家", status: "ACTIVE" },
    duplicate_candidates: [],
  });
  renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });

  expect(await screen.findByText("买家信息")).toBeInTheDocument();
  expect(screen.getByText("资金明细")).toBeInTheDocument();
  await saleUi.type(screen.getByLabelText("客户昵称"), "新买家");
  await saleUi.type(screen.getByLabelText("售出金额"), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));

  await waitFor(() => expect(vi.mocked(ordersApi.stockSale)).toHaveBeenCalledWith(21, expect.objectContaining({
    customer_input: expect.objectContaining({ display_name: "新买家", role: "BUYER" }),
    amount: "350", pool_id: 3, operator_user_ids: [1],
  })));
  expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
  expect(vi.mocked(customersApi.create)).not.toHaveBeenCalled();
  expect(vi.mocked(ordersApi.postEvent)).not.toHaveBeenCalled();
});

it("库存售出：成功后立即从库存列表移除账号，即使列表重拉暂时返回旧快照", async () => {
  const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
  renderLight(<InventoryPanel />, { user: "admin" });

  expect(await screen.findByText("acc-1")).toBeInTheDocument();
  await saleUi.click(within(screen.getByText("acc-1").closest("tr")!).getByRole("button", { name: "售出" }));
  await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
  await saleUi.type(screen.getByLabelText("售出金额"), "350");
  await saleUi.click(screen.getByLabelText("资金账户"));
  await saleUi.click(await screen.findByText(/利润池/));
  await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));

  await waitFor(() => expect(vi.mocked(ordersApi.stockSale)).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText("acc-1")).not.toBeInTheDocument());
});

describe("库存售出三表单分支", () => {
  it("代挂账号售出：全款收佣金入账、售出金额仅记录、不提供分期并挂寄售方", async () => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => [
      ...allFormFields().filter((field) => field.order_type_code === scope),
      ...(scope === "SALEDG" ? [{ id: 9001, order_type_code: scope, field_key: "sale_receipt", label: "售出凭据", field_type: "TEXT", options: [], required: true, is_active: true, sort_order: 99, locked: false, is_custom: true, section: "FINANCE", note: null },
        { id: 9002, order_type_code: scope, field_key: "optional_number", label: "售出附加数字", field_type: "NUMBER", required: false, is_active: true, sort_order: 100, locked: false, is_custom: true, section: "BUSINESS" }] : []),
    ] as never);
    const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce(inventoryLedgerResponse([{
      account: { ...accounts[0], id: 5, source_order_id: 21, game_account: "acc-5", inventory_type: "CONSIGNMENT" },
      order: { id: 21, order_no: "DG-2026-0001", order_type: "DG", trade_date: "2026-10-01", account_id: 5, account_status: "WAITING", status: "ACTIVE" },
    }], { type_counts: { CONSIGNMENT: 1 }, stats: { account_count: 1, occupied_cost: "50.00", over_7d_count: 0, over_30d_count: 0 } }) as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-5");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出代挂账号")).toBeInTheDocument();
    expect(screen.getByLabelText("利润")).toBeInTheDocument();
    expect(screen.getByLabelText("售出金额（仅记录）")).toBeInTheDocument();
    expect(screen.queryByText("付款方式")).toBeNull();
    expect(screen.queryByText("分期付款")).toBeNull();
    await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
    await saleUi.type(screen.getByPlaceholderText("请输入利润（代挂佣金）"), "200");
    await saleUi.type(screen.getByPlaceholderText("代挂无买入价，此处仅作记录，不计入利润"), "1000");
    await saleUi.type(await screen.findByLabelText("售出凭据"), "全款凭据");
    await saleUi.type(screen.getByLabelText("售出附加数字"), "17");
    await saleUi.clear(screen.getByLabelText("售出附加数字"));
    await saleUi.click(screen.getByLabelText("资金账户"));
    await saleUi.click(await screen.findByText(/利润池/));
    await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
    await waitFor(() => expect(vi.mocked(ordersApi.stockSale)).toHaveBeenCalled());
    expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
    expect(vi.mocked(ordersApi.stockSale)).toHaveBeenCalledWith(21, expect.objectContaining({
      amount: "200", pool_id: 3, sale_amount: "1000", form_extra: { sale_receipt: "全款凭据" }, customer_input: expect.objectContaining({ display_name: "买家A", role: "CONSIGNOR" }),
    }));
  });

  it("代挂售出复用买号交付信息块，交付操作人提交落库到来源单", async () => {
    const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce(inventoryLedgerResponse([{
      account: { ...accounts[0], id: 5, source_order_id: 21, game_account: "acc-5", inventory_type: "CONSIGNMENT" },
      order: { id: 21, order_no: "DG-2026-0001", order_type: "DG", trade_date: "2026-10-01", account_id: 5, account_status: "WAITING", status: "ACTIVE" },
    }], { type_counts: { CONSIGNMENT: 1 }, stats: { account_count: 1, occupied_cost: "50.00", over_7d_count: 0, over_30d_count: 0 } }) as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("acc-5");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出代挂账号")).toBeInTheDocument();
    expect(screen.getByText("交付操作人")).toBeInTheDocument();
    expect(screen.getByText("交易平台")).toBeInTheDocument();
    expect(screen.getByText("中介类型")).toBeInTheDocument();
    expect(screen.getByText("包赔类型")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("交付操作人").closest(".ant-select")).toHaveTextContent("管理员"));
    await saleUi.click(screen.getByLabelText("交易平台"));
    await saleUi.click(await screen.findByText("其他", { selector: ".ant-select-item-option-content" }));
    await saleUi.type(await screen.findByLabelText("其他平台"), "星河平台");
    await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
    await saleUi.type(screen.getByPlaceholderText("请输入利润（代挂佣金）"), "200");
    await saleUi.click(screen.getByLabelText("资金账户"));
    await saleUi.click(await screen.findByText(/利润池/));
    await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));
    await waitFor(() => expect(vi.mocked(ordersApi.stockSale)).toHaveBeenCalledWith(21, expect.objectContaining({
      delivery_form_extra: expect.objectContaining({ delivery_responsible_ids: [1], intermediary_platform: "其他", intermediary_platform_other: "星河平台" }),
    })));
  });

  it("分期售出金额字段拒绝超过两位小数", async () => {
    vi.mocked(installmentsApi.previewSalePlan).mockReturnValue(new Promise(() => {}));
    renderLight(<RecoverySaleModal account={accounts[0] as Account} onClose={vi.fn()} onCreated={vi.fn()} />, { user: "admin" });
    fireEvent.change(await screen.findByLabelText("售出金额"), { target: { value: "1.234" } });
    await ui.click(screen.getByText("分期付款"));
    for (const label of ["首付金额", "分期服务费总额", "每期服务费", "每期金额"]) {
      fireEvent.change(await screen.findByLabelText(label), { target: { value: "1.234" } });
    }
    await ui.click(screen.getByRole("button", { name: /确认售出/ }));
    for (const label of ["售出金额", "首付金额", "分期服务费总额", "每期服务费", "每期金额"]) {
      expect(await screen.findByText(`${label}必须是数字，最多两位小数`)).toBeInTheDocument();
    }
    expect(installmentsApi.stockSale).not.toHaveBeenCalled();
  });

  it("代挂售出金额和利润拒绝超过两位小数", async () => {
    renderLight(<ConsignmentSaleModal account={accounts[0] as Account} onClose={vi.fn()} onCreated={vi.fn()} />, { user: "admin" });
    fireEvent.change(await screen.findByLabelText("售出金额（仅记录）"), { target: { value: "1.234" } });
    fireEvent.change(screen.getByLabelText("利润"), { target: { value: "1.234" } });
    await ui.click(screen.getByRole("button", { name: /确认售出/ }));
    expect(await screen.findByText("售出金额（仅记录）必须是数字，最多两位小数")).toBeInTheDocument();
    expect(await screen.findByText("利润必须是数字，最多两位小数")).toBeInTheDocument();
    expect(ordersApi.stockSale).not.toHaveBeenCalled();
  });

  it("分期首付超过大额售出金额一分时提示并阻止提交", async () => {
    vi.mocked(installmentsApi.previewSalePlan).mockReturnValue(new Promise(() => {}));
    renderLight(<RecoverySaleModal account={accounts[0] as Account} onClose={vi.fn()} onCreated={vi.fn()} />, { user: "admin" });
    fireEvent.change(await screen.findByLabelText("售出金额"), { target: { value: "9999999999999999.98" } });
    await ui.click(screen.getByText("分期付款"));
    fireEvent.change(await screen.findByLabelText("首付金额"), { target: { value: "9999999999999999.99" } });
    await ui.click(screen.getByRole("button", { name: /确认售出/ }));
    expect(await screen.findByText("首付不能为负数或超过售出金额")).toBeInTheDocument();
    expect(installmentsApi.stockSale).not.toHaveBeenCalled();
  });

  it("分期预览回填大额金额并保留用户修改的分位", async () => {
    const preview = { per_period: "9999999999999999.98", per_period_service_fee: "9999999999999999.98" } as never;
    vi.mocked(installmentsApi.previewSalePlan).mockReturnValue(new Promise(() => {})).mockResolvedValueOnce(preview);
    renderLight(<RecoverySaleModal account={accounts[0] as Account} onClose={vi.fn()} onCreated={vi.fn()} />, { user: "admin" });
    fireEvent.change(await screen.findByLabelText("售出金额"), { target: { value: "100" } });
    await ui.click(screen.getByText("分期付款"));
    const perPeriod = await screen.findByLabelText("每期金额");
    const fee = screen.getByLabelText("每期服务费");
    await waitFor(() => expect(perPeriod).toHaveValue("9999999999999999.98"));
    expect(fee).toHaveValue("9999999999999999.98");
    const calls = vi.mocked(installmentsApi.previewSalePlan).mock.calls.length;
    vi.mocked(installmentsApi.previewSalePlan).mockResolvedValueOnce(preview);
    fireEvent.change(perPeriod, { target: { value: "9999999999999999.99" } });
    await waitFor(() => expect(installmentsApi.previewSalePlan).toHaveBeenCalledTimes(calls + 1));
    await waitFor(() => expect(perPeriod).toHaveValue("9999999999999999.99"));
  });

  it("分期金额变更后等待新预览时不显示旧的最后一期金额", async () => {
    const preview = { per_period: "50.00", per_period_service_fee: "0.00", last_period: "49.99" } as never;
    vi.mocked(installmentsApi.previewSalePlan).mockReset().mockResolvedValue(preview);
    renderLight(<RecoverySaleModal account={accounts[0] as Account} onClose={vi.fn()} onCreated={vi.fn()} />, { user: "admin" });
    fireEvent.change(await screen.findByLabelText("售出金额"), { target: { value: "100" } });
    await ui.click(screen.getByText("分期付款"));
    await waitFor(() => expect(screen.getByText("最后一期：49.99 元")).toBeInTheDocument());
    vi.mocked(installmentsApi.previewSalePlan).mockReturnValue(new Promise(() => {}));
    fireEvent.change(screen.getByLabelText("售出金额"), { target: { value: "120" } });
    await waitFor(() => expect(screen.queryByText("最后一期：49.99 元")).not.toBeInTheDocument());
  });

  it("提号库存售出可选择分期出售，确立时收首付", async () => {
    vi.mocked(orderFormFieldsApi.list).mockImplementation(async (scope) => [
      ...allFormFields().filter((field) => field.order_type_code === scope),
      ...(scope === "SALETH" ? [{ id: 9002, order_type_code: scope, field_key: "sale_receipt", label: "售出凭据", field_type: "TEXT", options: [], required: true, is_active: true, sort_order: 99, locked: false, is_custom: true, note: null }] : []),
    ] as never);
    const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce(inventoryLedgerResponse([{
      account: { ...accounts[0], id: 6, source_order_id: 21, game_account: "pickup-acc", inventory_type: "PICKUP", cost_amount: "0.00" },
      order: { id: 21, order_no: "TH-2026-0001", order_type: "TH", trade_date: "2026-10-01", account_id: 6, account_status: "WAITING", status: "ACTIVE" },
    }], { type_counts: { PICKUP: 1 }, stats: { account_count: 1, occupied_cost: "0.00", over_7d_count: 0, over_30d_count: 0 } }) as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await screen.findByText("pickup-acc");
    fireEvent.click(screen.getByRole("button", { name: /售出/ }));
    expect(await screen.findByText("售出提号账号")).toBeInTheDocument();
    await saleUi.click(screen.getByLabelText("交易平台"));
    await saleUi.click(await screen.findByText("其他", { selector: ".ant-select-item-option-content" }));
    await saleUi.type(await screen.findByLabelText("其他平台"), "分期平台");
    await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
    await saleUi.type(screen.getByPlaceholderText("请输入金额"), "1200");
    await saleUi.click(await screen.findByText("分期付款"));
    await saleUi.clear(screen.getByLabelText("首付金额"));
    await saleUi.type(screen.getByLabelText("首付金额"), "300");
    await saleUi.click(screen.getByLabelText("资金账户"));
    await saleUi.click(await screen.findByText(/利润池/));
    await saleUi.clear(screen.getByLabelText("分期期数"));
    await saleUi.type(screen.getByLabelText("分期期数"), "2");
    await saleUi.clear(screen.getByLabelText("每期金额"));
    await saleUi.type(screen.getByLabelText("每期金额"), "600");
    await saleUi.type(await screen.findByLabelText("售出凭据"), "分期凭据");
    expect(screen.getByLabelText("第 1 期到期日")).toBeInTheDocument();
    expect(screen.getByLabelText("第 2 期到期日")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /确认售出/ }));

    await waitFor(() => expect(vi.mocked(installmentsApi.stockSale)).toHaveBeenCalledWith(expect.objectContaining({
      order_id: 21, principal: "1200", down_payment: "300", pool_id: 3, operator_user_ids: [1], form_extra: { sale_receipt: "分期凭据" },
      delivery_form_extra: expect.objectContaining({ intermediary_platform: "其他", intermediary_platform_other: "分期平台" }),
    })));
    expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
    expect(vi.mocked(ordersApi.postEvent)).not.toHaveBeenCalled();
    expect(vi.mocked(installmentsApi.pay)).not.toHaveBeenCalled();
  });

  it("库存中心不为售出单提供取消入口", async () => {
    vi.mocked(stocksApi.inventoryLedger).mockResolvedValueOnce(inventoryLedgerResponse([]) as never);
    renderLight(<InventoryPanel />, { user: "admin" });
    await waitFor(() => expect(screen.queryByText("acc-2")).toBeNull());
    expect(screen.getByText("暂无账号")).toBeInTheDocument();
    expect(vi.mocked(ordersApi.postEvent)).not.toHaveBeenCalled();
  });

  it("售出表单统一使用资金明细且不增加支出", async () => {
    renderLight(<RecoverySaleModal account={accounts[0]} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
    expect(await screen.findByText("资金明细")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /增加支出/ })).not.toBeInTheDocument();
    expect(screen.queryByText("售出金额2")).not.toBeInTheDocument();
    expect(screen.queryByText("资金账户2")).not.toBeInTheDocument();
  });

  it("回收、提号、代挂三种售出表单都展示统一的交付信息", async () => {
    const deliveryLabels = ["换绑手机号", "手机号绑定人", "交易平台", "中介类型", "包赔类型", "交付操作人", "售出操作人"];
    const cases = [
      [RecoverySaleModal, accounts[0]],
      [PickupSaleModal, { ...accounts[0], inventory_type: "PICKUP" }],
      [ConsignmentSaleModal, { ...accounts[0], inventory_type: "CONSIGNMENT" }],
    ] as const;
    for (const [Modal, account] of cases) {
      const { unmount } = renderLight(<Modal account={account} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
      expect(await screen.findByText("交付信息")).toBeInTheDocument();
      for (const label of deliveryLabels) expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it("分期出售只对回收与提号开放，代挂仅全款", async () => {
    const cases = [
      [RecoverySaleModal, accounts[0], "买家信息", true],
      [PickupSaleModal, { ...accounts[0], inventory_type: "PICKUP" }, "买家信息", true],
      [ConsignmentSaleModal, { ...accounts[0], inventory_type: "CONSIGNMENT" }, "委托方信息", false],
    ] as const;
    for (const [Modal, account, buyerSection, supportsInstallment] of cases) {
      const { unmount } = renderLight(<Modal account={account} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
      await screen.findByText(buyerSection);
      if (supportsInstallment) expect(screen.getByText("付款方式")).toBeInTheDocument();
      else expect(screen.queryByText("付款方式")).toBeNull();
      unmount();
    }
  });

  it("三类售出各取独立作用域配置，互不共用", async () => {
    const cases = [
      [RecoverySaleModal, accounts[0], "SALEREC"],
      [PickupSaleModal, { ...accounts[0], inventory_type: "PICKUP" }, "SALETH"],
      [ConsignmentSaleModal, { ...accounts[0], inventory_type: "CONSIGNMENT" }, "SALEDG"],
    ] as const;
    for (const [Modal, account, scope] of cases) {
      vi.mocked(orderFormFieldsApi.list).mockClear();
      vi.mocked(orderFormFieldsApi.listSectionLabels).mockClear();
      const { unmount } = renderLight(<Modal account={account} onClose={() => undefined} onCreated={() => undefined} />, { user: "admin" });
      await waitFor(() => expect(orderFormFieldsApi.list).toHaveBeenCalledWith(scope, true));
      expect(vi.mocked(orderFormFieldsApi.list).mock.calls.every(([code]) => code === scope)).toBe(true);
      expect(orderFormFieldsApi.listSectionLabels).toHaveBeenCalledWith(scope);
      unmount();
    }
  });

  it("P1/FE-042：已拉黑客户不能参与库存售出", async () => {
    vi.mocked(ordersApi.stockSale).mockRejectedValueOnce(new Error("客户已拉黑，不能作为售出买家"));
    vi.mocked(poolsApi.list).mockResolvedValue([{ id: 3, code: "HJ_PROFIT", name: "利润池", status: "ACTIVE" }] as never);
    vi.mocked(employeesApi.list).mockResolvedValueOnce([{ id: 1, username: "admin", display_name: "管理员", is_active: true }] as never);
    renderLight(
      <RecoverySaleModal
        account={{ id: 1, source_order_id: 21, source_order_no: "HS-2026-0001", game_account: "acc-1", status: "WAITING", inventory_type: "RECOVERY" } as never}
        onClose={() => undefined}
        onCreated={() => undefined}
      />,
      { user: "admin" },
    );
    const saleUi = userEvent.setup({ pointerEventsCheck: 0 });
    await screen.findByText("买家信息");
    await saleUi.type(screen.getByLabelText("客户昵称"), "买家A");
    await saleUi.type(screen.getByLabelText("售出金额"), "350");
    await saleUi.click(screen.getByLabelText("资金账户"));
    await saleUi.click(await screen.findByText(/利润池/));
    await saleUi.click(screen.getByRole("button", { name: /确认售出/ }));

    await waitFor(() => expect(screen.getByText(/客户已拉黑，不能作为售出买家/)).toBeInTheDocument());
    expect(ordersApi.postEvent).not.toHaveBeenCalled();
  });
});

});
