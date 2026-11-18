import { within, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { renderLight } from "@fixtures/render";
import { OrderTypesPanel } from "@/field-definitions/panels/OrderTypesPanel";
import { orderTypesApi } from "@/shared/api/orders.api";
import type { OrderType } from "@/shared/api/types/orders";

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
vi.mock("@/shared/api/stocks.api");;

const rows: OrderType[] = [
  { id: 1, code: "HS", name: "回收", is_active: true, is_zero_principal: false, description: null, sort_order: 1 },
  { id: 2, code: "DG", name: "代挂", is_active: false, is_zero_principal: true, sort_order: 2 },
];
let ui: ReturnType<typeof userEvent.setup>;

async function rowOf(code: string): Promise<HTMLElement> {
  return (await screen.findByText(code)).closest("tr") as HTMLElement;
}

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.mocked(orderTypesApi.list).mockResolvedValue(rows);
  vi.mocked(orderTypesApi.setActive).mockResolvedValue(rows[0]);
  vi.mocked(orderTypesApi.update).mockResolvedValue(rows[0]);
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
});

describe("OrderTypesPanel 业务类型主数据", () => {
  it("加载并渲染列表（启用状态）", async () => {
    renderLight(<OrderTypesPanel />, { user: "admin" });
    expect(await screen.findByText("HS")).toBeInTheDocument();
    expect(screen.getByText("回收")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "零本金" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "启用" })).toBeInTheDocument();
  });

  it("空列表显示暂无业务类型", async () => {
    vi.mocked(orderTypesApi.list).mockResolvedValue([]);
    renderLight(<OrderTypesPanel />, { user: "admin" });
    expect(await screen.findByText("暂无业务类型")).toBeInTheDocument();
  });

  it("FE-211：业务类型主数据失败显示错误空态并禁用新建", async () => {
    vi.mocked(orderTypesApi.list).mockRejectedValue(new Error("types down"));
    renderLight(<OrderTypesPanel />, { user: "admin" });
    expect(await screen.findByText(/types down/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建类型/ })).toBeDisabled();
    expect(screen.getByText("业务类型数据不可用，请点击重新加载")).toBeInTheDocument();
  });

  it("停用：二次确认后调用 setActive(false) 并刷新列表", async () => {
    renderLight(<OrderTypesPanel />, { user: "admin" });
    const row = await rowOf("HS");
    await ui.click(within(row).getByRole("button", { name: /停用/ }));
    expect(await screen.findByText(/停用后无法新建该类型订单/)).toBeInTheDocument();
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    await waitFor(() => expect(orderTypesApi.setActive).toHaveBeenCalledWith(1, false));
    await waitFor(() => expect(orderTypesApi.list).toHaveBeenCalledTimes(2));
  });

  it("停用失败显示错误横幅", async () => {
    vi.mocked(orderTypesApi.setActive).mockRejectedValue(new Error("stop fail"));
    renderLight(<OrderTypesPanel />, { user: "admin" });
    const row = await rowOf("HS");
    await ui.click(within(row).getByRole("button", { name: /停用/ }));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    expect(await screen.findByText(/stop fail/)).toBeInTheDocument();
  });

  it("启用：未启用行显示启用按钮且描述不同", async () => {
    renderLight(<OrderTypesPanel />, { user: "admin" });
    const row = await rowOf("DG");
    await ui.click(within(row).getByRole("button", { name: /启用/ }));
    expect(await screen.findByText(/启用后可重新新建该类型订单/)).toBeInTheDocument();
    await ui.click(await screen.findByRole("button", { name: /确认/ }));
    await waitFor(() => expect(orderTypesApi.setActive).toHaveBeenCalledWith(2, true));
  });

  it("编辑：打开弹窗改名称后保存调用 update", async () => {
    renderLight(<OrderTypesPanel />, { user: "admin" });
    const row = await rowOf("HS");
    await ui.click(within(row).getByRole("button", { name: /编辑/ }));
    const modal = (await screen.findByText(/编辑业务类型 · HS/)).closest(".ant-modal-content") as HTMLElement;
    const nameInput = within(modal).getByLabelText("名称");
    await ui.clear(nameInput);
    await ui.type(nameInput, "回收2");
    await ui.click(within(modal).getByRole("button", { name: /保存/ }));
    await waitFor(() =>
      expect(orderTypesApi.update).toHaveBeenCalledWith(1, expect.objectContaining({ name: "回收2" }))
    );
    expect(message.success).toHaveBeenCalled();
  });

  it("编辑保存失败显示错误横幅", async () => {
    vi.mocked(orderTypesApi.update).mockRejectedValue(new Error("update fail"));
    renderLight(<OrderTypesPanel />, { user: "admin" });
    const row = await rowOf("HS");
    await ui.click(within(row).getByRole("button", { name: /编辑/ }));
    const modal = (await screen.findByText(/编辑业务类型 · HS/)).closest(".ant-modal-content") as HTMLElement;
    await ui.click(within(modal).getByRole("button", { name: /保存/ }));
    expect(await screen.findByText(/update fail/)).toBeInTheDocument();
  });

  it("无主数据维护权限时隐藏操作按钮并给出提示", async () => {
    renderLight(<OrderTypesPanel />, { user: "operator" });
    expect(await screen.findByText("当前角色无主数据维护权限，仅可查看。")).toBeInTheDocument();
    const row = await rowOf("HS");
    expect(within(row).queryByRole("button", { name: /编辑/ })).toBeNull();
    expect(within(row).queryByRole("button", { name: /停用/ })).toBeNull();
  });

  it("P1/FE-238：业务类型主数据失败时锁定新建入口", async () => {
    vi.mocked(orderTypesApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "types down" });
    renderLight(<OrderTypesPanel />, { user: "admin" });
    expect(await screen.findByText("业务类型数据不可用，请点击重新加载")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建类型/ })).toBeDisabled();
  });
});
