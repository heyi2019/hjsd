import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { CreateBusinessModal } from "./CreateBusinessModal";

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
    { id: 9, inventory_no: "ACC0001", game_account: "recovery-account", business_mode: "SELF", inventory_type: "RECOVERY", status: "IN_STOCK", cost_amount: "0.00" },
    { id: 10, inventory_no: "ACC0002", game_account: "consignment-account", business_mode: "DISTRIBUTION", inventory_type: "CONSIGNMENT", status: "IN_STOCK", cost_amount: "0.00" },
    { id: 11, inventory_no: "ACC0003", game_account: "pickup-account", business_mode: "DISTRIBUTION", inventory_type: "PICKUP", status: "IN_STOCK", cost_amount: "0.00" },
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
  renderApp(<CreateBusinessModal open onClose={() => undefined} onCreated={onCreated} initialOrderType={orderType as "HS" | "TH" | "DG" | "DFQ"} />, { user });
    const title = await screen.findByText(orderType === "HS" ? "新建回收订单" : orderType === "TH" ? "新建提号订单" : orderType === "DG" ? "新建代挂订单" : orderType === "DFQ" ? "新建代分期订单" : "新建业务");
  return { container: title.closest(".ant-modal-content") as HTMLElement, onCreated };
}

describe("CreateBusinessModal：新建业务写路径", () => {
  it("回收入口内联填写游戏账号信息，不加载库存账号", async () => {
    const { container } = await openTypedModal("HS");

    expect(await screen.findByLabelText("游戏账号")).toBeInTheDocument();
    expect(screen.queryByLabelText("库存编号")).toBeNull();
    expect(accountsList).not.toHaveBeenCalled();
    expect(ordersList).not.toHaveBeenCalled();
    expect(typesList).not.toHaveBeenCalled();
  });

  it("打开回收入口后只加载订单所需的业务数据", async () => {
    const { container } = await openModal();
    expect(await screen.findByLabelText("游戏账号")).toBeInTheDocument();
    expect(screen.queryByLabelText("库存编号")).toBeNull();
    expect(typesList).not.toHaveBeenCalled();
    expect(accountsList).not.toHaveBeenCalled();
    expect(ordersList).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("关联账号（必填）");
  });

  it("必填校验：未选业务类型不给提交", async () => {
    await openModal();
    await userEvent.click(screen.getByRole("button", { name: /创建订单/ }));
    await waitFor(() => expect(ordersCreate).not.toHaveBeenCalled());
  });

  it("建单失败时错误落到弹窗内 ErrorBanner（不静默）", async () => {
    ordersCreate.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "POOL_ROUTE_MISSING", message: "缺少资金池路由" } },
      message: "Request failed",
    });
    const { container } = await openTypedModal("TH");
    await userEvent.type(screen.getByLabelText("供货方昵称"), "同行甲");
    await userEvent.type(screen.getByLabelText("游戏类型"), "王者荣耀");
    await userEvent.type(screen.getByLabelText("游戏账号"), "pickup-account");
    await userEvent.type(screen.getByLabelText("账号密码"), "secret");
    await userEvent.type(screen.getByLabelText("渠道／区服"), "安卓一区");
    await userEvent.click(screen.getByLabelText("供货方来源").closest(".ant-form-item")?.querySelector(".ant-select-selector") as Element);
    await userEvent.click(await screen.findByText("氪金联盟", { selector: ".ant-select-item-option-content" }));
    const amounts = screen.getAllByPlaceholderText("请输入金额");
    await userEvent.type(amounts[0], "1000");
    await userEvent.type(amounts[1], "1200");
    await userEvent.click(container.querySelector(".payment-info-fields .ant-select-selector") as Element);
    await userEvent.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
    await userEvent.click(screen.getByRole("button", { name: /创建订单/ }));
    expect(await screen.findByText(/设置 → 主数据/)).toBeInTheDocument();
  });

  it("viewer 无 order.create → 提交按钮不渲染（入口由页面层 PermissionGate 决定）", async () => {
    await openModal("viewer");
    expect(screen.queryByRole("button", { name: /创建订单/ })).toBeNull();
  });

  it("提号建单：复用回收费用与付款结构，并登记供货方", async () => {
    ordersCreate.mockResolvedValueOnce({ id: 8, order_no: "TH-2026-0008", status: "ACTIVE" });
    const { container, onCreated } = await openTypedModal("TH");
    await userEvent.type(screen.getByLabelText("供货方昵称"), "同行甲");
    await userEvent.type(screen.getByLabelText("游戏类型"), "王者荣耀");
    await userEvent.type(screen.getByLabelText("游戏账号"), "pickup-account");
    await userEvent.type(screen.getByLabelText("账号密码"), "secret");
    await userEvent.type(screen.getByLabelText("渠道／区服"), "安卓一区");
    await userEvent.click(screen.getByLabelText("供货方来源").closest(".ant-form-item")?.querySelector(".ant-select-selector") as Element);
    await userEvent.click(await screen.findByText("氪金联盟", { selector: ".ant-select-item-option-content" }));
    const amounts = screen.getAllByPlaceholderText("请输入金额");
    await userEvent.type(amounts[0], "1000");
    await userEvent.type(amounts[1], "1200");
    await userEvent.click(container.querySelector(".payment-info-fields .ant-select-selector") as Element);
    await userEvent.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
    await userEvent.click(screen.getByRole("button", { name: /创建订单/ }));
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
