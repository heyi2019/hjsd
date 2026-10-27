import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { CreateBusinessModal } from "./CreateBusinessModal";
import * as catalog from "../shared/api/catalog";
import { resolveMock, resolveMockOnce } from "../test/mock-api";
import { seedOrderFormFields } from "../test/formFieldsSeed";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

// 自动 mock：所有导出（含嵌套 ordersApi / orderTypesApi / ...）均为 vi.fn()，
// 跨文件在 isolate:false 下复用同一份 mock 实例，避免闭包捕获的 vi.fn() 串扰。
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
it("提号建单：复用回收费用与付款结构，并登记供货方", async () => {
    resolveMockOnce(vi.mocked(catalog.ordersApi.create), { id: 8, order_no: "TH-2026-0008", status: "ACTIVE" });
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
    await waitFor(() => expect(vi.mocked(catalog.ordersApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(catalog.ordersApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.order_type).toBe("TH");
    expect(payload.account_snapshot).toBeUndefined();
    expect(payload.account).toBeUndefined();
    expect(payload.account_id).toBeUndefined();
    expect(payload.customer_roles).toEqual([]);
    expect(payload.counterparty_roles).toEqual([{ counterparty_id: 2, role: "PEER" }]);
    expect(payload.note).toBe("供货方来源：氪金联盟｜预期收买家：1200");
    expect(payload.initial_buy).toMatchObject({ amount: "1000", pool_id: 1 });
    expect(vi.mocked(catalog.ordersApi.postEvent)).not.toHaveBeenCalled();
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

it("代挂新客户保存填写的姓名", async () => {
    resolveMockOnce(vi.mocked(catalog.customersApi.create), { customer: { id: 12, display_name: "新客户" } });
    resolveMockOnce(vi.mocked(catalog.ordersApi.create), { id: 8, order_no: "DG-8", status: "ACTIVE" });
    await openTypedModal("DG");
    await ui.type(screen.getByLabelText("客户昵称"), "新客户");
    await ui.type(document.querySelector<HTMLInputElement>("#dg_customer_contact")!, "李明");
    await ui.type(screen.getByLabelText("游戏账号"), "test-account");
    await ui.type(screen.getByLabelText("账号密码"), "secret");
    await ui.type(screen.getByLabelText("渠道／区服"), "一区");
    await ui.type(screen.getByLabelText("客户来源"), "介绍");
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    await waitFor(() => expect(vi.mocked(catalog.customersApi.create)).toHaveBeenCalledWith(expect.objectContaining({ contact_name: "李明" })));
  });

it("提号选择其他来源时必须填写具体来源", async () => {
    await openTypedModal("TH");
    await ui.click(screen.getByLabelText("供货方来源").closest(".ant-form-item")!.querySelector(".ant-select-selector")!);
    await ui.click(await screen.findByText("其他", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    expect(await screen.findByText("请输入供货方来源")).toBeInTheDocument();
  });

it("切换供货方来源后清除其他来源的旧值", async () => {
    await openTypedModal("TH");
    const selector = screen.getByLabelText("供货方来源").closest(".ant-form-item")!.querySelector(".ant-select-selector")!;
    await ui.click(selector);
    await ui.click(await screen.findByText("其他", { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("其他来源"), "旧来源");
    await ui.click(selector);
    await ui.click(await screen.findByText("同行", { selector: ".ant-select-item-option-content" }));
    await ui.click(selector);
    await ui.click(await screen.findByText("其他", { selector: ".ant-select-item-option-content" }));
    expect(screen.getByLabelText("其他来源")).toHaveValue("");
  });

it("代分期不展示无法保存的期次字段", async () => {
    await openTypedModal("DFQ");
    expect(screen.queryByText("本期费率")).toBeNull();
    expect(screen.queryByText("期次备注")).toBeNull();
  });

it("代分期根据号价和首付计算借款本金", async () => {
    await openTypedModal("DFQ");
    await ui.type(screen.getByPlaceholderText("账号全款基础价格"), "1000");
    await ui.type(screen.getByPlaceholderText("客户已支付的部分号款"), "200");
    expect(screen.getByPlaceholderText("客户借款的剩余号款")).toHaveValue("800");
  });

it("代分期显示最后一期承担尾差", async () => {
    await openTypedModal("DFQ");
    await ui.type(screen.getByPlaceholderText("账号全款基础价格"), "1000");
    const periods = screen.getByPlaceholderText("请输入期数");
    await ui.clear(periods);
    await ui.type(periods, "3");
    expect(await screen.findByText("最后一期：333.32 元")).toBeInTheDocument();
  });

it("代分期每期金额保持表单控件唯一，说明文本不参与字段绑定", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await openTypedModal("DFQ");
    await ui.type(screen.getByPlaceholderText("账号全款基础价格"), "1000");
    const periods = screen.getByPlaceholderText("请输入期数");
    await ui.clear(periods);
    await ui.type(periods, "3");

    expect(await screen.findByText("最后一期：333.32 元")).toBeInTheDocument();
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("A `Form.Item` with a `name` prop must have a single child element"),
    );
    errorSpy.mockRestore();
  });

it("增加代分期期数时自动补充分期计划", async () => {
    await openTypedModal("DFQ");
    const periods = screen.getByPlaceholderText("请输入期数");
    await ui.clear(periods);
    await ui.type(periods, "3");
    expect(screen.getByText("第 3 期")).toBeInTheDocument();
  });

it("减少期数前确认删除已填写的到期日", async () => {
    await openTypedModal("DFQ");
    const periods = screen.getByPlaceholderText("请输入期数");
    await ui.clear(periods);
    await ui.type(periods, "2");
    await ui.type(screen.getAllByPlaceholderText("请选择日期")[1], "2026-11-01{enter}");
    await ui.clear(periods);
    await ui.type(periods, "1");
    expect((await screen.findAllByText("减少期数会删除已填写的到期日")).length).toBeGreaterThan(0);
    await ui.click(screen.getByRole("button", { name: /保留期次/ }));
    expect(periods).toHaveValue("2");
    expect(screen.getByText("第 2 期")).toBeInTheDocument();
  });

it("代分期不接受负手续费", async () => {
    await openTypedModal("DFQ");
    await ui.type(screen.getByPlaceholderText("分期服务手续费"), "-1");
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    expect(await screen.findByText("手续费必须为非负金额")).toBeInTheDocument();
  });

it("代分期期数必须为正整数且与计划数量一致", async () => {
    await openTypedModal("DFQ");
    const periods = screen.getByPlaceholderText("请输入期数");
    await ui.clear(periods);
    await ui.type(periods, "2");
    await ui.click(screen.getByRole("button", { name: /添加期次/ }));
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    expect(await screen.findByText("分期计划数量须与期数一致")).toBeInTheDocument();
    await ui.clear(periods);
    await ui.type(periods, "1.5");
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    expect(await screen.findByText("期数必须为 1 至 120 的整数")).toBeInTheDocument();
  });

it("代分期表单展示金额、可自定义期次和付款信息", async () => {
    const { container } = await openTypedModal("DFQ");

    expect(screen.getByText("借款与分期信息")).toBeInTheDocument();
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
