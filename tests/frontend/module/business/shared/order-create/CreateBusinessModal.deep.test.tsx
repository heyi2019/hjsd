import { screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { CreateBusinessModal } from "@/business/shared/order-create/CreateBusinessModal";
import { gameTypesApi } from "@/shared/api/misc.api";
import { orderFormFieldsApi, orderTypesApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { seedOptionSets } from "@fixtures/optionSetsSeed";

// 自动 mock：所有导出（含嵌套 ordersApi / orderTypesApi / ...）均为 vi.fn()
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

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  seedOptionSets();
  seedOrderFormFields();
  vi.mocked(orderTypesApi.list).mockResolvedValue([{ id: 1, code: "HS", name: "回收", is_active: true }]);
  resolveMock(vi.mocked(poolsApi.list), [{ id: 1, name: "主账户", code: "MAIN", status: "ACTIVE" }]);
  vi.mocked(gameTypesApi.list).mockResolvedValue([
    { id: 1, value: "game_01", name: "王者荣耀", sort_order: 10, is_active: true, is_default: true,
      channel_regions: [{ value: "channel_01", label: "安卓一区" }] },
  ]);
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "系统管理员", is_active: true },
  ]);
});

// antd Modal（含 ConfirmDialog）渲染在 document.body 下，testing-library 的 cleanup 不覆盖，
// 重试/后续用例会残留多份 modal（其异步挂载时机可能与 afterEach 清理错开），需手动移除。
afterEach(() => {
  cleanup();
  document.body.querySelectorAll('[class*="ant-modal"]').forEach((el) => el.remove());
});

async function openTypedModal(orderType: string, onClose = vi.fn(), onCreated = vi.fn()) {
  renderLight(
    <CreateBusinessModal open onClose={onClose} onCreated={onCreated} initialOrderType={orderType as "HS" | "TH" | "DG"} />,
    { user: "admin" },
  );
  const title = await screen.findByText(
    orderType === "HS" ? "新建回收订单" : orderType === "TH" ? "新建提号订单" : orderType === "DG" ? "新建代挂订单" : "新建业务",
  );
  return { container: title.closest(".ant-modal-content") as HTMLElement, onClose, onCreated };
}

describe("CreateBusinessModal.deep：加载失败/取消确认/联动清除", () => {
  it("字段配置读取失败时阻止建单并可重试", async () => {
    vi.mocked(orderFormFieldsApi.list).mockRejectedValueOnce(new Error("字段配置网络错误"));
    await openTypedModal("HS");
    expect(await screen.findByText(/字段配置加载失败/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /创建订单/ })).toBeDisabled();
    await ui.type(screen.getByLabelText("客户昵称"), "保留客户输入");
    await ui.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.queryByText(/字段配置加载失败/)).not.toBeInTheDocument());
    expect(screen.getByLabelText("客户昵称")).toHaveValue("保留客户输入");
    expect(screen.getByRole("button", { name: /创建订单/ })).toBeEnabled();
  });
  it("业务数据加载失败后可在表单内重试并保留已输入内容", async () => {
    vi.mocked(poolsApi.list).mockRejectedValueOnce(new Error("load fail"));
    await openTypedModal("HS");
    expect((await screen.findAllByText(/load fail/)).length).toBeGreaterThan(0);
    await ui.type(screen.getByLabelText("客户昵称"), "已输入的客户");
    await ui.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(poolsApi.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/load fail/)).not.toBeInTheDocument());
    expect(screen.getByLabelText("客户昵称")).toHaveValue("已输入的客户");
    await ui.click(screen.getByLabelText("资金账户"));
    expect(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("提交客户草稿给订单接口，由后端在同一事务中解析档案", async () => {
    resolveMockOnce(vi.mocked(ordersApi.create), { id: 31, order_no: "HS-2026-0031", status: "ACTIVE" });

    await openTypedModal("HS");
    await waitFor(() => expect(screen.getByLabelText("游戏类型")).toBeEnabled());
    await ui.click(screen.getByLabelText("游戏类型"));
    await ui.click(await screen.findByText("王者荣耀", { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("游戏账号"), "recovery-account");
    await ui.type(screen.getByLabelText("账号密码"), "secret");
    await ui.click(screen.getByLabelText("渠道／区服"));
    await ui.click(await screen.findByText("安卓一区", { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("客户昵称"), "张三");
    // CfgNestedItem 把客户手机号嵌在客户信息区，label 会被 antd 组合前缀；按字段 id 精确定位。
    await ui.type(document.querySelector("#customer_phone") as Element, "13800008888");
    await ui.type(screen.getByPlaceholderText("请输入金额"), "1000");
    // 选中回收资金账户
    const poolPlaceholder = screen.getByText("请选择资金账户", { exact: true });
    await ui.click(poolPlaceholder.closest(".ant-select")!.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));

    await waitFor(() => expect(vi.mocked(ordersApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(ordersApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.customer_input).toMatchObject({
      display_name: "张三", phone: "13800008888", role: "SELLER",
    });
    expect(payload.account_snapshot).toMatchObject({ game_type: "game_01", channel_region: "channel_01" });
  });

  it("客户来源只能从预置选项选择，选择其他后填写具体来源", async () => {
    await openTypedModal("HS");
    const source = screen.getByLabelText("客户来源");
    await ui.click(source.closest(".ant-form-item")!.querySelector(".ant-select-selector") as Element);
    expect(await screen.findByText("微博", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    expect(screen.getByText("小红书", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    expect(screen.getByLabelText("其他来源")).toBeDisabled();
    await ui.click(screen.getByText("其他", { selector: ".ant-select-item-option-content" }));
    expect(screen.getByLabelText("其他来源")).toBeEnabled();
  });
});
