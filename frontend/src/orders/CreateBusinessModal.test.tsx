import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { CreateBusinessModal } from "./CreateBusinessModal";
import { DfqOrderSection } from "./dfq/DfqOrderSection";
import { FieldConfigContext } from "./ConfigurableField";
import { Form } from "antd";
import * as catalog from "../shared/api/catalog";
import { resolveMock, resolveMockOnce } from "../test/mock-api";
import { allFormFields, seedOrderFormFields } from "../test/formFieldsSeed";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

// 自动 mock：所有导出（含嵌套 ordersApi / orderTypesApi / ...）均为 vi.fn()，
// 跨文件在 isolate:false 下复用同一份 mock 实例，配合 setup.ts 的 resetAllMocks
// 与各文件 beforeEach 重新设定返回值，避免闭包捕获的 vi.fn() 在共享模块图下串扰。
vi.mock("../shared/api/catalog");

const types = [{ id: 1, code: "HS", name: "回收", capital_type: "SELF", is_active: true }];

beforeEach(() => {
  vi.clearAllMocks();
  seedOrderFormFields(catalog);
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue(types);
  vi.mocked(catalog.customersApi.list).mockResolvedValue([{ id: 1, customer_no: "CUS-0001", display_name: "张三", status: "ACTIVE" }]);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue([{ id: 2, counterparty_no: "CP-0001", display_name: "同行甲", type: "PEER", status: "ACTIVE" }]);
  resolveMock(vi.mocked(catalog.accountsApi.list), [
    { id: 9, game_account: "recovery-account", business_mode: "SELF", inventory_type: "RECOVERY", status: "IN_STOCK", cost_amount: "0.00" },
    { id: 10, game_account: "consignment-account", business_mode: "DISTRIBUTION", inventory_type: "CONSIGNMENT", status: "IN_STOCK", cost_amount: "0.00" },
    { id: 11, game_account: "pickup-account", business_mode: "DISTRIBUTION", inventory_type: "PICKUP", status: "IN_STOCK", cost_amount: "0.00" },
  ]);
  resolveMock(vi.mocked(catalog.poolsApi.list), [{ id: 1, name: "主账户", code: "MAIN", status: "ACTIVE" }]);
  vi.mocked(catalog.gameTypesApi.list).mockResolvedValue([
    { id: 1, name: "王者荣耀", sort_order: 10, is_active: true, is_default: true },
    { id: 2, name: "原神", sort_order: 20, is_active: true, is_default: false },
  ]);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([{ id: 10, order_no: "HJ-HS-0001", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-15", status: "ACTIVE", account_id: 9 }]);
  resolveMock(vi.mocked(catalog.ordersApi.postEvent), { event: { id: 1 }, cashflow_no: "FLOW-0001" });
});

/** 打开弹窗，返回弹窗容器与 onCreated 探针。
 *  rc-select 只在展开后才把选项挂进 DOM，故「等选项出现」前必须先点开下拉。 */
async function openModal(user = "admin") {
  return openTypedModal("HS", user);
}

async function openTypedModal(orderType: string, user = "admin") {
  const onCreated = vi.fn();
  renderLight(<CreateBusinessModal open onClose={() => undefined} onCreated={onCreated} initialOrderType={orderType as "HS" | "TH" | "DG" | "DFQ"} />, { user });
  const title = await screen.findByText(orderType === "HS" ? "新建回收订单" : orderType === "TH" ? "新建提号订单" : orderType === "DG" ? "新建代挂订单" : orderType === "DFQ" ? "新建代分期订单" : "新建业务");
  return { container: title.closest(".ant-modal-content") as HTMLElement, onCreated };
}

describe("CreateBusinessModal：新建业务写路径", () => {
it("代分期的金额字段与账号备注读取表单字段配置", async () => {
  renderLight(
    <Form>
      <FieldConfigContext.Provider value={{
        dfq_purchase_price: { id: 301, order_type_code: "DFQ", field_key: "dfq_purchase_price", label: "购号成本", field_type: "NUMBER", options: null, required: true, is_active: true, sort_order: 110, locked: true, is_custom: false, note: null },
        dfq_account_note: { id: 302, order_type_code: "DFQ", field_key: "dfq_account_note", label: "账号补充说明", field_type: "TEXT", options: null, required: false, is_active: true, sort_order: 70, locked: false, is_custom: false, note: null },
        dfq_period_amount: { id: 303, order_type_code: "DFQ", field_key: "dfq_period_amount", label: "每期金额", field_type: "NUMBER", options: null, required: false, is_active: false, sort_order: 160, locked: false, is_custom: false, note: null },
      }}>
        <DfqOrderSection pools={[]} />
      </FieldConfigContext.Provider>
    </Form>,
  );

  expect(screen.getByText(/购号成本/)).toBeInTheDocument();
  expect(screen.getByLabelText("账号补充说明")).toBeInTheDocument();
  expect(screen.queryByText(/每期金额/)).toBeNull();
});

it("回收入口内联填写游戏账号信息，不加载库存账号", async () => {
    const { container } = await openTypedModal("HS");

    expect(await screen.findByLabelText("游戏账号")).toBeInTheDocument();
    expect(screen.queryByLabelText("库存编号")).toBeNull();
    expect(vi.mocked(catalog.accountsApi.list)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.ordersApi.list)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.orderTypesApi.list)).not.toHaveBeenCalled();
  });

it("打开回收入口后只加载订单所需的业务数据", async () => {
    const { container } = await openModal();
    expect(await screen.findByLabelText("游戏账号")).toBeInTheDocument();
    expect(screen.queryByLabelText("库存编号")).toBeNull();
    expect(vi.mocked(catalog.orderTypesApi.list)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.accountsApi.list)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.ordersApi.list)).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("关联账号（必填）");
  });

it("回收订单不渲染后台遗留的自定义字段", async () => {
  vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue([
    ...allFormFields(),
    {
      id: 9901,
      order_type_code: "HS",
      field_key: "qa500_recovery_note",
      label: "QA500 回收说明",
      field_type: "TEXT",
      options: null,
      required: false,
      is_active: true,
      sort_order: 999,
      locked: false,
      is_custom: true,
      note: null,
    },
  ]);

  await openModal();

  await screen.findByLabelText("客户昵称");
  expect(screen.queryByLabelText("QA500 回收说明")).toBeNull();
  expect(screen.queryByTestId("custom-fields")).toBeNull();
});

it("必填校验：未选业务类型不给提交", async () => {
    await openModal();
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    await waitFor(() => expect(vi.mocked(catalog.ordersApi.create)).not.toHaveBeenCalled());
  });

it("建单失败时错误落到弹窗内 ErrorBanner（不静默）", async () => {
    vi.mocked(catalog.ordersApi.create).mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "POOL_ROUTE_MISSING", message: "缺少资金池路由" } },
      message: "Request failed",
    });
    const { container } = await openTypedModal("TH");
    await ui.type(screen.getByLabelText("供货方昵称"), "同行甲");
    await ui.type(screen.getByLabelText("游戏类型"), "王者荣耀");
    await ui.type(screen.getByLabelText("游戏账号"), "pickup-account");
    await ui.type(screen.getByLabelText("账号密码"), "secret");
    await ui.type(screen.getByLabelText("渠道／区服"), "安卓一区");
    await ui.click(screen.getByLabelText("供货方来源").closest(".ant-form-item")?.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("氪金联盟", { selector: ".ant-select-item-option-content" }));
    const amounts = screen.getAllByPlaceholderText("请输入金额");
    await ui.type(amounts[0], "1000");
    await ui.type(amounts[1], "1200");
    await ui.click(container.querySelector(".payment-info-fields .ant-select-selector") as Element);
    await ui.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    expect(await screen.findByText(/设置 → 主数据/)).toBeInTheDocument();
  });

it("设计费走 DESIGN 资金分类（不再落到 OTHER）", async () => {
    resolveMockOnce(vi.mocked(catalog.ordersApi.create), { id: 11, order_no: "HS-2026-0011", status: "ACTIVE" });
    await openModal();
    await ui.type(screen.getByLabelText("游戏类型"), "王者荣耀");
    await ui.type(screen.getByLabelText("游戏账号"), "recovery-account");
    await ui.type(screen.getByLabelText("账号密码"), "secret");
    await ui.type(screen.getByLabelText("渠道／区服"), "安卓一区");
    await ui.type(screen.getAllByPlaceholderText("请输入金额")[0], "1000");
    await ui.type(screen.getByLabelText("设计费"), "50");
    await ui.type(screen.getByLabelText("客户昵称"), "张三");
    await ui.click(screen.getByLabelText("客户来源").closest(".ant-form-item")!.querySelector(".ant-select-selector")!);
    await ui.click(await screen.findByText("闲鱼", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByLabelText("付款资金账户").closest(".ant-form-item")!.querySelector(".ant-select-selector")!);
    await ui.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    await waitFor(() => expect(vi.mocked(catalog.ordersApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(catalog.ordersApi.create).mock.calls[0][0] as Record<string, unknown>;
    const costs = payload.initial_costs as Array<Record<string, unknown>>;
    expect(costs).toEqual([expect.objectContaining({ amount: "50", flow_category: "DESIGN", note: "设计费" })]);
  });

it("代挂单的佣金口径随建单提交（支付方式与承担方成对落到顶层字段）", async () => {
  resolveMockOnce(vi.mocked(catalog.ordersApi.create), { id: 21, order_no: "DG-2026-0021", status: "ACTIVE" });
  // 代挂建单会先按昵称建档（昵称必填），这里补上建档返回，避免走到 catch 分支。
  vi.mocked(catalog.customersApi.create).mockResolvedValue({
    customer: { id: 3, customer_no: "CUS-0003", display_name: "李四", status: "ACTIVE" },
    duplicate_candidates: [],
  });
  await openTypedModal("DG");
  await ui.type(screen.getByLabelText("游戏类型"), "王者荣耀");
  await ui.type(screen.getByLabelText("游戏账号"), "consignment-account");
  await ui.type(screen.getByLabelText("账号密码"), "secret");
  await ui.type(screen.getByLabelText("渠道／区服"), "安卓一区");
  await ui.type(screen.getByLabelText("客户昵称"), "李四");
  await ui.click(screen.getByLabelText("客户来源").closest(".ant-form-item")!.querySelector(".ant-select-selector")!);
  await ui.click(await screen.findByText("闲鱼", { selector: ".ant-select-item-option-content" }));
  await ui.click(screen.getByLabelText("佣金支付方式").closest(".ant-form-item")!.querySelector(".ant-select-selector")!);
  await ui.click(await screen.findByText("结算扣减", { selector: ".ant-select-item-option-content" }));
  await ui.click(screen.getByLabelText("佣金承担方").closest(".ant-form-item")!.querySelector(".ant-select-selector")!);
  await ui.click(await screen.findByText("寄售方", { selector: ".ant-select-item-option-content" }));
  await ui.click(screen.getByRole("button", { name: /创建订单/ }));
  await waitFor(() => expect(vi.mocked(catalog.ordersApi.create)).toHaveBeenCalled());
  const payload = vi.mocked(catalog.ordersApi.create).mock.calls[0][0] as Record<string, unknown>;
  expect(payload.commission_mode).toBe("DEDUCT_FROM_SETTLEMENT");
  expect(payload.commission_payer).toBe("CONSIGNOR");
});

it("viewer 无 order.create → 提交按钮不渲染（入口由页面层 PermissionGate 决定）", async () => {
    await openModal("viewer");
    expect(screen.queryByRole("button", { name: /创建订单/ })).toBeNull();
  });
});
