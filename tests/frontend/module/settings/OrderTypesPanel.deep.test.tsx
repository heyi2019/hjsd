import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { OrderTypesPanel } from "@/field-definitions/panels/OrderTypesPanel";
import { orderTypesApi } from "@/shared/api/orders.api";
import { poolsApi } from "@/shared/api/pools.api";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/quality.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

const rows = [
  { id: 1, code: "HS", name: "回收", capital_type: "STOCK", is_active: true, description: null, sort_order: 1 },
  { id: 2, code: "DG", name: "代挂", capital_type: "ZERO", is_active: false, sort_order: 2 },
];
const pools = [
  { id: 1, code: "POOL-A", name: "主资金池", pool_type: "MAIN", ownership: "SELF", status: "ACTIVE" },
];

let ui: ReturnType<typeof userEvent.setup>;

async function rowOf(code: string): Promise<HTMLElement> {
  return (await screen.findByText(code)).closest("tr") as HTMLElement;
}

async function pickSelect(modal: HTMLElement, label: string, optionText: string) {
  await ui.click(
    within(modal).getByLabelText(label).closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement,
  );
  await ui.click(await screen.findByText(optionText, { selector: ".ant-select-item-option-content" }));
}

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.mocked(orderTypesApi.list).mockResolvedValue(rows);
  vi.mocked(orderTypesApi.create).mockResolvedValue({ id: 99, code: "XY", name: "新业务" } as never);
  vi.mocked(orderTypesApi.routes).mockResolvedValue([]);
  vi.mocked(orderTypesApi.setRoute).mockResolvedValue(undefined as never);
  vi.mocked(poolsApi.list).mockResolvedValue(pools);
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
});

describe("OrderTypesPanel.deep", () => {
  it("新建业务类型成功：提交 create + 重新加载", async () => {
    renderLight(<OrderTypesPanel />, { user: "admin" });
    await screen.findByText("HS");
    await ui.click(screen.getByRole("button", { name: /新建类型/ }));
    const modal = (await screen.findByText("新建业务类型")).closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("代码"), "XY");
    await ui.type(within(modal).getByLabelText("名称"), "新业务");
    await ui.click(within(modal).getByRole("button", { name: /创建/ }));
    await waitFor(() =>
      expect(vi.mocked(orderTypesApi.create)).toHaveBeenCalledWith(
        expect.objectContaining({ code: "XY", name: "新业务", capital_type: "STOCK", sort_order: 0 }),
      ),
    );
    expect(message.success).toHaveBeenCalledWith("业务类型已创建");
    await waitFor(() => expect(vi.mocked(orderTypesApi.list)).toHaveBeenCalledTimes(2));
  });

  it("新建业务类型失败：提示错误", async () => {
    vi.mocked(orderTypesApi.create).mockRejectedValue(new Error("create fail"));
    renderLight(<OrderTypesPanel />, { user: "admin" });
    await screen.findByText("HS");
    await ui.click(screen.getByRole("button", { name: /新建类型/ }));
    const modal = (await screen.findByText("新建业务类型")).closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("代码"), "ZZ");
    await ui.type(within(modal).getByLabelText("名称"), "坏业务");
    await ui.click(within(modal).getByRole("button", { name: /创建/ }));
    await waitFor(() => expect(vi.mocked(orderTypesApi.create)).toHaveBeenCalled());
    expect(message.error).toHaveBeenCalledWith(expect.stringMatching(/create fail/));
  });

  it("保存路由成功：提交 setRoute + 刷新路由列表", async () => {
    vi.mocked(orderTypesApi.routes).mockResolvedValue([
      { id: 1, order_type_code: "HS", portion: "PRINCIPAL", fund_nature: null, pool_code: "POOL-A", pool_name: "主资金池", priority: 1, is_active: true },
    ]);
    renderLight(<OrderTypesPanel />, { user: "admin" });
    const row = await rowOf("HS");
    await ui.click(within(row).getByRole("button", { name: /路由/ }));
    const modal = (await screen.findByText(/资金路由 · HS/)).closest(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, "目标资金池", "主资金池（POOL-A）");
    await ui.click(within(modal).getByRole("button", { name: /保存路由/ }));
    await waitFor(() =>
      expect(vi.mocked(orderTypesApi.setRoute)).toHaveBeenCalledWith(
        "HS",
        expect.objectContaining({ portion: "PRINCIPAL", pool_code: "POOL-A", fund_nature: null, priority: 0 }),
      ),
    );
    expect(message.success).toHaveBeenCalledWith("资金路由已保存");
    await waitFor(() => expect(vi.mocked(orderTypesApi.routes)).toHaveBeenCalledTimes(2));
  });

  it("保存路由失败：提示错误", async () => {
    vi.mocked(orderTypesApi.setRoute).mockRejectedValue(new Error("route fail"));
    renderLight(<OrderTypesPanel />, { user: "admin" });
    const row = await rowOf("HS");
    await ui.click(within(row).getByRole("button", { name: /路由/ }));
    const modal = (await screen.findByText(/资金路由 · HS/)).closest(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, "目标资金池", "主资金池（POOL-A）");
    await ui.click(within(modal).getByRole("button", { name: /保存路由/ }));
    await waitFor(() => expect(vi.mocked(orderTypesApi.setRoute)).toHaveBeenCalled());
    expect(message.error).toHaveBeenCalledWith(expect.stringMatching(/route fail/));
  });
});
