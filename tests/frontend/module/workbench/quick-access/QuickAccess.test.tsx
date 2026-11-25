import { fireEvent, screen } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { QuickAccess } from "@/workbench/quick-access/QuickAccess";

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

beforeEach(() => {
  vi.clearAllMocks();
  seedOrderFormFields();
});

describe("QuickAccess 快捷入口", () => {
  it("viewer 无 order.create → 看不到新建业务卡", async () => {
    await act(async () => {
      renderLight(<QuickAccess />, { user: "viewer" });
      await Promise.resolve();
    });
    // 无卡可点：给一帧让权限门控渲染完再断言（sync 渲染，无需 waitFor 数据）。
    expect(screen.queryByRole("button", { name: /自营·回收/ })).toBeNull();
  });

  it("点击回收账号卡直接打开回收登记弹窗（不跳转页面）", async () => {
    renderLight(<QuickAccess />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: /自营·回收/ }));
    const modal = await screen.findByText("新建回收订单", {}, { timeout: 10_000 });
    expect(modal.closest(".ant-modal-content")).toBeTruthy();
  });

  it("点击共同出售口进入业务中心库存页", async () => {
    const onNavigate = vi.fn();
    renderLight(<QuickAccess onNavigate={onNavigate} />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: /售出库存账号/ }));
    expect(onNavigate).toHaveBeenCalledWith("business", "inventory");
  });

  it("点击提号卡直接打开提号登记弹窗（不跳转页面）", async () => {
    renderLight(<QuickAccess />, { user: "admin" });
    fireEvent.click(await screen.findByRole("button", { name: "提号" }));
    const modal = await screen.findByText("新建提号订单", {}, { timeout: 10_000 });
    expect(modal.closest(".ant-modal-content")).toBeTruthy();
  });

  it("点「代挂」卡打开代挂登记弹窗", async () => {
    renderLight(<QuickAccess />, { user: "admin" });
    await screen.findByRole("button", { name: "代挂" });
    await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getByRole("button", { name: "代挂" }));
    expect(await screen.findByText("新建代挂订单", {}, { timeout: 10_000 })).toBeInTheDocument();
  });
});
