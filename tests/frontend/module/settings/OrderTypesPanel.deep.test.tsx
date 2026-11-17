import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { OrderTypesPanel } from "@/field-definitions/panels/OrderTypesPanel";
import { orderTypesApi } from "@/shared/api/orders.api";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

const rows = [
  { id: 1, code: "HS", name: "回收", is_active: true, description: null, sort_order: 1 },
  { id: 2, code: "DG", name: "代挂", is_active: false, sort_order: 2 },
];
let ui: ReturnType<typeof userEvent.setup>;

async function rowOf(code: string): Promise<HTMLElement> {
  return (await screen.findByText(code)).closest("tr") as HTMLElement;
}

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.mocked(orderTypesApi.list).mockResolvedValue(rows);
  vi.mocked(orderTypesApi.create).mockResolvedValue({ id: 99, code: "XY", name: "新业务" } as never);
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
        expect.objectContaining({ code: "XY", name: "新业务", sort_order: 0 }),
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


});
