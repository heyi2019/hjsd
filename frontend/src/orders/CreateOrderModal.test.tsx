import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { CreateOrderModal } from "./CreateOrderModal";

const ordersCreate = vi.fn();
const typesList = vi.fn();
const customersList = vi.fn();
const counterpartiesList = vi.fn();
const accountsList = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  ordersApi: { create: (...a: unknown[]) => ordersCreate(...a) },
  orderTypesApi: { list: (...a: unknown[]) => typesList(...a) },
  customersApi: { list: (...a: unknown[]) => customersList(...a) },
  counterpartiesApi: { list: (...a: unknown[]) => counterpartiesList(...a) },
  accountsApi: { list: (...a: unknown[]) => accountsList(...a) },
}));

const types = [{ id: 1, code: "HS", name: "回收", capital_type: "SELF", is_active: true }];

beforeEach(() => {
  vi.clearAllMocks();
  typesList.mockResolvedValue(types);
  customersList.mockResolvedValue([{ id: 1, customer_no: "CUS-0001", display_name: "张三", status: "ACTIVE" }]);
  counterpartiesList.mockResolvedValue([]);
  accountsList.mockResolvedValue([{ id: 9, account_no: "HJACC-0001", status: "IN_STOCK", cost_amount: "0.00" }]);
});

/** 打开弹窗，返回弹窗容器与 onCreated 探针。
 *  rc-select 只在展开后才把选项挂进 DOM，故「等选项出现」前必须先点开下拉。 */
async function openModal(user = "admin") {
  const onCreated = vi.fn();
  renderApp(<CreateOrderModal open onClose={() => undefined} onCreated={onCreated} />, { user });
  const title = await screen.findByText("新建业务");
  const container = title.closest(".ant-modal-content") as HTMLElement;
  return { container, onCreated };
}

describe("CreateOrderModal：新建业务写路径", () => {
  it("打开后自加载选项：业务类型下拉出现 HS 回收", async () => {
    const { container } = await openModal();
    expect(typesList).toHaveBeenCalled();
    await userEvent.click(container.querySelectorAll(".ant-select-selector")[0] as Element);
    expect(await screen.findByTitle("HS 回收")).toBeTruthy();
  });

  it("必填校验：未选业务类型不给提交", async () => {
    await openModal();
    await userEvent.click(screen.getByRole("button", { name: /创建草稿/ }));
    await waitFor(() => expect(ordersCreate).not.toHaveBeenCalled());
  });

  it("建单提交后回传业务类型与默认成交日期，并触发 onCreated 刷新", async () => {
    ordersCreate.mockResolvedValueOnce({ id: 3, order_no: "HS-2026-0003", status: "DRAFT" });
    const { container, onCreated } = await openModal();
    await userEvent.click(container.querySelectorAll(".ant-select-selector")[0] as Element);
    await userEvent.click(await screen.findByTitle("HS 回收"));
    await userEvent.click(screen.getByRole("button", { name: /创建草稿/ }));
    await waitFor(() => expect(ordersCreate).toHaveBeenCalled());
    const payload = ordersCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.order_type).toBe("HS");
    expect(payload.trade_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it("建单失败时错误落到弹窗内 ErrorBanner（不静默）", async () => {
    ordersCreate.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "POOL_ROUTE_MISSING", message: "缺少资金池路由" } },
      message: "Request failed",
    });
    const { container } = await openModal();
    await userEvent.click(container.querySelectorAll(".ant-select-selector")[0] as Element);
    await userEvent.click(await screen.findByTitle("HS 回收"));
    await userEvent.click(screen.getByRole("button", { name: /创建草稿/ }));
    expect(await screen.findByText(/设置 → 主数据/)).toBeInTheDocument();
  });

  it("viewer 无 order.create → 提交按钮不渲染（入口由页面层 PermissionGate 决定）", async () => {
    await openModal("viewer");
    expect(screen.queryByRole("button", { name: /创建草稿/ })).toBeNull();
  });
});
