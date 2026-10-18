import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { CreateBusinessModal } from "./CreateBusinessModal";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

const ordersCreate = vi.fn();
const orderEvents = vi.fn();
const typesList = vi.fn();
const customersList = vi.fn();
const counterpartiesList = vi.fn();
const accountsList = vi.fn();
const poolsList = vi.fn();
const ordersList = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  ordersApi: {
    list: (...a: unknown[]) => ordersList(...a),
    create: (...a: unknown[]) => ordersCreate(...a),
    postEvent: (...a: unknown[]) => orderEvents(...a),
  },
  orderTypesApi: { list: (...a: unknown[]) => typesList(...a) },
  customersApi: { list: (...a: unknown[]) => customersList(...a) },
  counterpartiesApi: { list: (...a: unknown[]) => counterpartiesList(...a) },
  accountsApi: {
    list: (...a: unknown[]) => accountsList(...a),
  },
  poolsApi: { list: (...a: unknown[]) => poolsList(...a) },
}));

const types = [{ id: 1, code: "HS", name: "回收", capital_type: "SELF", is_active: true }];

beforeEach(() => {
  vi.clearAllMocks();
  typesList.mockResolvedValue(types);
  customersList.mockResolvedValue([{ id: 1, customer_no: "CUS-0001", display_name: "张三", status: "ACTIVE" }]);
  counterpartiesList.mockResolvedValue([{ id: 2, counterparty_no: "CP-0001", display_name: "同行甲", type: "SUPPLIER", status: "ACTIVE" }]);
  accountsList.mockResolvedValue([
    { id: 9, game_account: "recovery-account", business_mode: "SELF", inventory_type: "RECOVERY", status: "IN_STOCK", cost_amount: "0.00" },
    { id: 10, game_account: "consignment-account", business_mode: "DISTRIBUTION", inventory_type: "CONSIGNMENT", status: "IN_STOCK", cost_amount: "0.00" },
    { id: 11, game_account: "pickup-account", business_mode: "DISTRIBUTION", inventory_type: "PICKUP", status: "IN_STOCK", cost_amount: "0.00" },
  ]);
  poolsList.mockResolvedValue([{ id: 1, name: "主账户", code: "MAIN", status: "ACTIVE" }]);
  ordersList.mockResolvedValue([{ id: 10, order_no: "HJ-HS-0001", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-15", status: "ACTIVE", account_id: 9 }]);
  orderEvents.mockResolvedValue({ event: { id: 1 }, cashflow_no: "FLOW-0001" });
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
it("提号建单：复用回收费用与付款结构，并登记供货方", async () => {
    ordersCreate.mockResolvedValueOnce({ id: 8, order_no: "TH-2026-0008", status: "ACTIVE" });
    const { container, onCreated } = await openTypedModal("TH");
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
    await waitFor(() => expect(ordersCreate).toHaveBeenCalled());
    const payload = ordersCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.order_type).toBe("TH");
    expect(payload.account_snapshot).toBeUndefined();
    expect(payload.account).toBeUndefined();
    expect(payload.account_id).toBeUndefined();
    expect(payload.customer_roles).toEqual([]);
    expect(payload.counterparty_roles).toEqual([{ counterparty_id: 2, role: "SUPPLIER" }]);
    expect(payload.note).toBe("供货方来源：氪金联盟｜预期收买家：1200");
    await waitFor(() => expect(orderEvents).toHaveBeenCalledTimes(1));
    expect(orderEvents.mock.calls[0][1]).toMatchObject({ event_type: "BUY", amount: "1000", pool_id: 1 });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

it("代挂建单沿用统一出售流程，不展示独立结算字段", async () => {
    const { container } = await openTypedModal("DG");

    expect(screen.getByText("委托客户")).toBeInTheDocument();
    expect(screen.queryByText("挂售价：")).toBeNull();
    expect(screen.queryByText("服务费／抽成：")).toBeNull();
    expect(screen.queryByText("抽成方式：")).toBeNull();
    expect(screen.queryByText("付款方：")).toBeNull();
    expect(screen.queryByText("预计结算日：")).toBeNull();
    expect(screen.getByLabelText("客户昵称")).toBeInTheDocument();
    expect(screen.queryByText("分期设置")).toBeNull();
    expect(screen.queryByLabelText("建立代挂分期合同")).toBeNull();
  });

it("代分期表单展示金额、可自定义期次和付款信息", async () => {
    const { container } = await openTypedModal("DFQ");

    expect(screen.getByText("分期信息")).toBeInTheDocument();
    expect(screen.getByText("手续费总额：")).toBeInTheDocument();
    expect(screen.getByText("每期手续费：")).toBeInTheDocument();
    expect(screen.getByText("分期计划")).toBeInTheDocument();
    expect(screen.getByText("付款信息")).toBeInTheDocument();
    expect(screen.queryByLabelText("关联订单编号")).toBeNull();
    expect(screen.getByText("第 1 期")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /添加期次/ })).toBeInTheDocument();
    expect(container.querySelector('[id$="dfq_customer_nickname"]')).toBeInTheDocument();
  });
});
