import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appMessage as message } from "@/shared/ui/appFeedback";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { CustomerLeadPanel } from "@/customer-center/CustomerLeadPanel";
import { customersApi, leadsApi } from "@/shared/api/customers.api";
import { employeesApi } from "@/shared/api/org.api";
import { orderFormFieldsApi } from "@/shared/api/orders.api";
import type { Customer, Lead } from "@/shared/api/types/customers";
import { seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { pageResponse } from "@fixtures/api-responses";

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

const customers: Customer[] = [
  { id: 1, customer_no: "C-1", display_name: "张三", status: "ACTIVE" },
];

const leads: Lead[] = [
  { id: 1, lead_no: "LD-1", customer_id: 1, customer_display_name: "张三", request_type: "FIND_ACCOUNT", budget: "100.00", target: "找一个号", status: "OPEN" },
  { id: 2, lead_no: "LD-2", customer_id: 1, customer_display_name: "张三", request_type: "SELL_ACCOUNT", budget: null, target: "卖个号", status: "CLOSED" },
];

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  seedOrderFormFields();
  vi.mocked(leadsApi.page).mockResolvedValue(pageResponse(leads));
  vi.mocked(customersApi.page).mockResolvedValue(pageResponse(customers, { limit: 500 }));
  vi.mocked(leadsApi.create).mockResolvedValue(leads[0]);
  vi.mocked(leadsApi.close).mockResolvedValue(leads[0]);
  vi.mocked(leadsApi.convert).mockResolvedValue(leads[0]);
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "管理员", is_active: true },
  ]);
  vi.spyOn(message, "success").mockReturnValue(undefined as never);
  vi.spyOn(message, "error").mockReturnValue(undefined as never);
});

describe("CustomerLeadPanel：客户需求池", () => {
  it("加载成功后渲染需求列表、客户名与统计", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText("LD-1")).toBeInTheDocument();
    expect(screen.getAllByText("张三").length).toBeGreaterThan(0);
    expect(screen.getByText("找号")).toBeInTheDocument();
    expect(screen.getByText("需求总数")).toBeInTheDocument();
    expect(screen.getByText("待跟进")).toBeInTheDocument();
  });

  it("无需求时显示空态文案", async () => {
    vi.mocked(leadsApi.page).mockResolvedValue(pageResponse([]));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText("暂无客户需求")).toBeInTheDocument();
  });

  it("加载失败展示错误横幅", async () => {
    vi.mocked(leadsApi.page).mockRejectedValue(new Error("lead down"));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText(/lead down/)).toBeInTheDocument();
  });

  it("客户列表为空时允许打开新增但禁止提交", async () => {
    vi.mocked(customersApi.page).mockResolvedValue(pageResponse([], { limit: 500 }));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText("需求总数")).toBeInTheDocument();
    const createButton = screen.getByRole("button", { name: /新增需求/ });
    expect(createButton).toBeEnabled();
    await ui.click(createButton);
    const modal = await screen.findByText("新增客户需求");
    expect(within(modal.closest(".ant-modal-content") as HTMLElement).getByRole("button", { name: /创建需求/ })).toBeDisabled();
  });

  it("首屏不加载客户全集，点击新增时才加载客户选项", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await screen.findByText("LD-1");
    expect(customersApi.page).not.toHaveBeenCalled();

    await ui.click(screen.getByRole("button", { name: /新增需求/ }));
    await screen.findByText("新增客户需求");
    expect(customersApi.page).toHaveBeenCalledWith({ status: "ACTIVE", limit: 500, offset: 0 });
  });

  it("需求列表直接展示后端返回的客户名称", async () => {
    vi.mocked(customersApi.page).mockResolvedValue(pageResponse([], { limit: 500 }));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    expect(within(row).getByText("张三")).toBeInTheDocument();
  });

  it("需求列表由后台分页并传入当前页参数", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await screen.findByText("LD-1");
    expect(leadsApi.page).toHaveBeenCalledWith({ limit: 10, offset: 0 });
  });

  it("重新激活客户需求池时刷新列表", async () => {
    const view = renderLight(<CustomerLeadPanel active={false} />, { user: "admin" });
    expect(leadsApi.page).not.toHaveBeenCalled();

    view.rerender(<CustomerLeadPanel active />);
    expect(await screen.findByText("LD-1")).toBeInTheDocument();
    await waitFor(() => expect(leadsApi.page).toHaveBeenCalledWith({ limit: 10, offset: 0 }));
  });

  it("新增需求填表并提交调用 leadsApi.create", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await ui.click(await screen.findByRole("button", { name: /新增需求/ }));
    const modal = screen.getByText("新增客户需求").closest(".ant-modal-content") as HTMLElement;
    expect(modal.closest(".ant-modal")).toHaveStyle({ width: "520px" });
    await ui.click(screen.getByLabelText("客户").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("C-1 · 张三", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByLabelText("需求类型").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("找号", { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("预算"), "100");
    await ui.type(screen.getByLabelText("需求目标"), "找一个号");
    await ui.click(within(modal).getByRole("button", { name: /创建需求/ }));
    await waitFor(() => expect(leadsApi.create).toHaveBeenCalled());
    expect(leadsApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: 1, request_type: "FIND_ACCOUNT", budget: "100", target: "找一个号" }),
    );
  });

  it("新增需求接口失败时展示错误", async () => {
    vi.mocked(leadsApi.create).mockRejectedValue(new Error("create boom"));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await ui.click(await screen.findByRole("button", { name: /新增需求/ }));
    const modal = screen.getByText("新增客户需求").closest(".ant-modal-content") as HTMLElement;
    await ui.click(screen.getByLabelText("客户").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("C-1 · 张三", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByLabelText("需求类型").closest(".ant-form-item")!.querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("找号", { selector: ".ant-select-item-option-content" }));
    await ui.type(screen.getByLabelText("预算"), "100");
    await ui.type(screen.getByLabelText("需求目标"), "找一个号");
    await ui.click(within(modal).getByRole("button", { name: /创建需求/ }));
    expect(await screen.findByText(/create boom/)).toBeInTheDocument();
  });

  it("点击行内关闭打开弹窗并提交调用 leadsApi.close", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: /关闭/ }));
    const modal = screen.getByText("关闭客户需求").closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("关闭原因"), "已成交");
    await ui.click(within(modal).getByRole("button", { name: /确认关闭/ }));
    await waitFor(() => expect(leadsApi.close).toHaveBeenCalledWith(1, "已成交", undefined, [1]));
  });

  it("点击行内转单打开弹窗并提交调用 leadsApi.convert", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: /转单/ }));
    const modal = screen.getByText("需求转单").closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("订单编号"), "99");
    await ui.click(within(modal).getByRole("button", { name: /确认转单/ }));
    await waitFor(() => expect(leadsApi.convert).toHaveBeenCalledWith(1, 99, undefined, [1]));
  });

  it("转单订单编号必须是正整数", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: /转单/ }));
    const modal = screen.getByText("需求转单").closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("订单编号"), "1.5");
    await ui.click(within(modal).getByRole("button", { name: /确认转单/ }));

    expect(await screen.findByText("订单编号必须是正整数")).toBeInTheDocument();
    expect(vi.mocked(leadsApi.convert)).not.toHaveBeenCalled();
  });

  it("配置停用后关闭弹窗不渲染「关闭原因」字段", async () => {
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([
      { id: 1, order_type_code: "LEADCLOSE", field_key: "reason", label: "关闭原因", field_type: "TEXT", options: null, required: true, is_active: false, sort_order: 10, locked: false, is_custom: false, note: null },
    ] as never);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: /关闭/ }));
    const modal = screen.getByText("关闭客户需求").closest(".ant-modal-content") as HTMLElement;
    await waitFor(() => expect(within(modal).queryByLabelText("关闭原因")).toBeNull());
    await ui.click(within(modal).getByRole("button", { name: /确认关闭/ }));
    await waitFor(() => expect(leadsApi.close).toHaveBeenCalledWith(1, undefined, undefined, [1]));
  });

  it("转单弹窗「订单编号」标签取配置值", async () => {
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([
      { id: 2, order_type_code: "LEADCONVERT", field_key: "order_id", label: "关联订单号", field_type: "TEXT", options: null, required: true, is_active: true, sort_order: 10, locked: false, is_custom: false, note: null },
    ] as never);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: /转单/ }));
    const modal = screen.getByText("需求转单").closest(".ant-modal-content") as HTMLElement;
    await waitFor(() => expect(within(modal).getByLabelText("关联订单号")).toBeInTheDocument());
  });

  it("已关闭需求不渲染行内操作按钮", async () => {
    vi.mocked(leadsApi.page).mockResolvedValue(pageResponse([
      { id: 2, lead_no: "LD-2", customer_id: 1, customer_display_name: "张三", request_type: "SELL_ACCOUNT", budget: null, target: "卖个号", status: "CLOSED" },
    ]));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await screen.findByText("LD-2");
    expect(screen.queryByRole("button", { name: /转单/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /关闭/ })).toBeNull();
  });
});
