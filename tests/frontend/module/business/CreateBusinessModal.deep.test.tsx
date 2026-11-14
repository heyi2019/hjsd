import { screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { CreateBusinessModal } from "@/orders/CreateBusinessModal";
import { gameTypesApi } from "@/shared/api/misc.api";
import { orderTypesApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";
import { seedOrderFormFields } from "@fixtures/formFieldsSeed";

// 自动 mock：所有导出（含嵌套 ordersApi / orderTypesApi / ...）均为 vi.fn()
vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  seedOrderFormFields();
  vi.mocked(orderTypesApi.list).mockResolvedValue([{ id: 1, code: "HS", name: "回收", capital_type: "SELF", is_active: true }]);
  resolveMock(vi.mocked(stocksApi.list), [
    { id: 9, game_account: "recovery-account", business_mode: "SELF", inventory_type: "RECOVERY", status: "WAITING", cost_amount: "0.00" },
  ]);
  resolveMock(vi.mocked(poolsApi.list), [{ id: 1, name: "主账户", code: "MAIN", status: "ACTIVE" }]);
  vi.mocked(gameTypesApi.list).mockResolvedValue([
    { id: 1, name: "王者荣耀", sort_order: 10, is_active: true, is_default: true },
  ]);
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "系统管理员", is_active: true },
  ]);
  vi.mocked(ordersApi.list).mockResolvedValue([]);
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
  it("业务数据加载失败展示错误横幅（弹窗内无重试入口）", async () => {
    vi.mocked(poolsApi.list).mockRejectedValue(new Error("load fail"));
    await openTypedModal("HS");
    expect((await screen.findAllByText(/load fail/)).length).toBeGreaterThan(0);
    // 组件未给 ErrorBanner 传 onRetry，故弹窗内无「重新加载」按钮；load 的 catch 分支已覆盖
    expect(screen.queryByText("重新加载")).toBeNull();
  });

  it("已填写表单点关闭触发放弃确认，确认后 onClose", async () => {
    const onClose = vi.fn();
    await openTypedModal("HS", onClose);
    await ui.type(screen.getByLabelText("客户昵称"), "李四");
    await ui.click(screen.getByRole("button", { name: "Close" }));
    // 放弃确认框出现，未确认前不关闭
    expect(await screen.findByText("放弃未保存的建单内容？")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // 放弃确认用 ConfirmDialog（Modal 级）：按可访问名精确点击，兼作 loading 图标污染的回归护栏。
    await ui.click(screen.getByRole("button", { name: "放弃" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("提交客户草稿给订单接口，由后端在同一事务中解析档案", async () => {
    resolveMockOnce(vi.mocked(ordersApi.create), { id: 31, order_no: "HS-2026-0031", status: "ACTIVE" });

    await openTypedModal("HS");
    await ui.type(screen.getByLabelText("游戏类型"), "王者荣耀");
    await ui.type(screen.getByLabelText("游戏账号"), "recovery-account");
    await ui.type(screen.getByLabelText("账号密码"), "secret");
    await ui.type(screen.getByLabelText("渠道／区服"), "安卓一区");
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
