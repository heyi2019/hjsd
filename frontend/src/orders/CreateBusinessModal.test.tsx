import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { CreateBusinessModal, getAccountValues } from "./CreateBusinessModal";

const ordersCreate = vi.fn();
const orderEvents = vi.fn();
const typesList = vi.fn();
const customersList = vi.fn();
const counterpartiesList = vi.fn();
const accountsList = vi.fn();
const accountsCreate = vi.fn();
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
    create: (...a: unknown[]) => accountsCreate(...a),
  },
  poolsApi: { list: (...a: unknown[]) => poolsList(...a) },
}));

const types = [{ id: 1, code: "HS", name: "回收", capital_type: "SELF", is_active: true }];

beforeEach(() => {
  vi.clearAllMocks();
  typesList.mockResolvedValue(types);
  customersList.mockResolvedValue([{ id: 1, customer_no: "CUS-0001", display_name: "张三", status: "ACTIVE" }]);
  counterpartiesList.mockResolvedValue([{ id: 2, counterparty_no: "CP-0001", display_name: "同行甲", type: "SUPPLIER", status: "ACTIVE" }]);
  accountsList.mockResolvedValue([{ id: 9, inventory_no: "ACC0001", status: "IN_STOCK", cost_amount: "0.00" }]);
  accountsCreate.mockResolvedValue({ id: 11, inventory_no: "ACC0011", status: "IN_STOCK", cost_amount: "0.00" });
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
  it("业务入口不再加载通用账号兼容数据", async () => {
    const { container } = await openTypedModal("HS");

    expect(container.textContent).not.toContain("关联账号（必填）");
    expect(accountsList).not.toHaveBeenCalled();
    expect(ordersList).not.toHaveBeenCalled();
    expect(typesList).not.toHaveBeenCalled();
  });

  it("代挂账号字段使用 dg 前缀，不复用提号字段", () => {
    expect(getAccountValues({
      dg_game_type: "王者荣耀",
      dg_game_account: "dg-account",
      dg_game_password: "secret",
      dg_channel_region: "安卓一区",
      dg_bound_phone: "13800000000",
      dg_has_secondary: "有",
      dg_account_note: "代挂账号",
    }, "DG")).toMatchObject({
      game_type: "王者荣耀",
      game_account: "dg-account",
      game_password: "secret",
      channel_region: "安卓一区",
      bound_phone: "13800000000",
      has_secondary: true,
      inventory_type: "CONSIGNMENT",
      business_mode: "DISTRIBUTION",
      note: "代挂账号",
    });
  });

  it("打开回收入口后只加载订单所需的业务数据", async () => {
    const { container } = await openModal();
    expect(await screen.findByLabelText("游戏类型")).toBeInTheDocument();
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
    await userEvent.type(screen.getByLabelText("游戏账号"), "account-1");
    await userEvent.type(screen.getByLabelText("账号密码"), "password-1");
    await userEvent.type(screen.getByLabelText("渠道／区服"), "安卓一区／微信");
    await userEvent.click(container.querySelectorAll(".ant-select-selector")[5] as Element);
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
    const selectors = container.querySelectorAll(".ant-select-selector");
    await userEvent.type(screen.getByLabelText("游戏类型"), "王者荣耀");
    await userEvent.type(screen.getByLabelText("游戏账号"), "account-1");
    await userEvent.type(screen.getByLabelText("账号密码"), "password-1");
    await userEvent.type(screen.getByLabelText("渠道／区服"), "安卓一区／微信");
    await userEvent.click(selectors[5]);
    await userEvent.click(await screen.findByText("氪金联盟", { selector: ".ant-select-item-option-content" }));
    const amounts = screen.getAllByPlaceholderText("请输入金额");
    await userEvent.type(amounts[0], "1000");
    await userEvent.type(amounts[1], "1200");
    await userEvent.type(screen.getByLabelText("账号备注"), "提号账号说明");
    await userEvent.click(container.querySelector(".payment-info-fields .ant-select-selector") as Element);
    await userEvent.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
    await userEvent.click(screen.getByRole("button", { name: /创建订单/ }));
    await waitFor(() => expect(ordersCreate).toHaveBeenCalled());
    const payload = ordersCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.order_type).toBe("TH");
    expect(payload.account_snapshot).toMatchObject({
      game_type: "王者荣耀",
      game_account: "account-1",
      game_password: "password-1",
      channel_region: "安卓一区／微信",
      note: "提号账号说明",
    });
    expect(payload.account).toBeUndefined();
    expect(payload.account_id).toBeUndefined();
    expect(payload.customer_roles).toEqual([]);
    expect(payload.counterparty_roles).toEqual([{ counterparty_id: 2, role: "SUPPLIER" }]);
    expect(payload.note).toBe("提号账号说明｜供货方来源：氪金联盟｜预期收买家：1200");
    expect(orderEvents).toHaveBeenCalledTimes(1);
    expect(orderEvents.mock.calls[0][1]).toMatchObject({ event_type: "BUY", amount: "1000", pool_id: 1 });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it("代挂表单先展示完整前端字段", async () => {
    const { container } = await openTypedModal("DG");

    expect(screen.getByText("委托客户")).toBeInTheDocument();
    expect(screen.getByText("挂售价：")).toBeInTheDocument();
    expect(screen.getByText("服务费／抽成：")).toBeInTheDocument();
    expect(screen.getByText("抽成方式：")).toBeInTheDocument();
    expect(screen.getByText("付款方：")).toBeInTheDocument();
    expect(screen.getByText("预计结算日：")).toBeInTheDocument();
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
