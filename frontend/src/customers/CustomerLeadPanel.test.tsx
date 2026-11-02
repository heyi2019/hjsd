import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appMessage as message } from "../shared/ui/appFeedback";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { CustomerLeadPanel } from "./CustomerLeadPanel";
import * as catalog from "../shared/api/catalog";
import type { Customer, Lead } from "../shared/api/catalog";
import { seedOrderFormFields } from "../test/formFieldsSeed";

vi.mock("../shared/api/catalog");

const customers: Customer[] = [
  { id: 1, customer_no: "C-1", display_name: "张三", status: "ACTIVE" },
];

const leads: Lead[] = [
  { id: 1, lead_no: "LD-1", customer_id: 1, request_type: "FIND_ACCOUNT", budget: "100.00", target: "找一个号", status: "OPEN" },
  { id: 2, lead_no: "LD-2", customer_id: 1, request_type: "SELL_ACCOUNT", budget: null, target: "卖个号", status: "CLOSED" },
];

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  seedOrderFormFields(catalog);
  vi.mocked(catalog.leadsApi.list).mockResolvedValue(leads);
  vi.mocked(catalog.customersApi.list).mockResolvedValue(customers);
  vi.mocked(catalog.leadsApi.create).mockResolvedValue(leads[0]);
  vi.mocked(catalog.leadsApi.close).mockResolvedValue(leads[0]);
  vi.mocked(catalog.leadsApi.convert).mockResolvedValue(leads[0]);
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
    vi.mocked(catalog.leadsApi.list).mockResolvedValue([]);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText("暂无客户需求")).toBeInTheDocument();
  });

  it("加载失败展示错误横幅", async () => {
    vi.mocked(catalog.leadsApi.list).mockRejectedValue(new Error("lead down"));
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText(/lead down/)).toBeInTheDocument();
  });

  it("客户列表为空时禁用新增需求入口", async () => {
    vi.mocked(catalog.customersApi.list).mockResolvedValue([]);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    expect(await screen.findByText("需求总数")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新增需求/ })).toBeDisabled();
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
    await waitFor(() => expect(catalog.leadsApi.create).toHaveBeenCalled());
    expect(catalog.leadsApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: 1, request_type: "FIND_ACCOUNT", budget: "100", target: "找一个号" }),
    );
  });

  it("新增需求接口失败时展示错误", async () => {
    vi.mocked(catalog.leadsApi.create).mockRejectedValue(new Error("create boom"));
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
    await waitFor(() => expect(catalog.leadsApi.close).toHaveBeenCalledWith(1, "已成交", undefined));
  });

  it("点击行内转单打开弹窗并提交调用 leadsApi.convert", async () => {
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: /转单/ }));
    const modal = screen.getByText("需求转单").closest(".ant-modal-content") as HTMLElement;
    await ui.type(within(modal).getByLabelText("订单 ID"), "99");
    await ui.click(within(modal).getByRole("button", { name: /确认转单/ }));
    await waitFor(() => expect(catalog.leadsApi.convert).toHaveBeenCalledWith(1, 99, undefined));
  });

  it("配置停用后关闭弹窗不渲染「关闭原因」字段", async () => {
    vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue([
      { id: 1, order_type_code: "LEADCLOSE", field_key: "reason", label: "关闭原因", field_type: "TEXT", options: null, required: true, is_active: false, sort_order: 10, locked: false, is_custom: false, note: null },
    ] as never);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: /关闭/ }));
    const modal = screen.getByText("关闭客户需求").closest(".ant-modal-content") as HTMLElement;
    await waitFor(() => expect(within(modal).queryByLabelText("关闭原因")).toBeNull());
    await ui.click(within(modal).getByRole("button", { name: /确认关闭/ }));
    await waitFor(() => expect(catalog.leadsApi.close).toHaveBeenCalledWith(1, undefined, undefined));
  });

  it("转单弹窗「订单 ID」标签取配置值", async () => {
    vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue([
      { id: 2, order_type_code: "LEADCONVERT", field_key: "order_id", label: "关联订单号", field_type: "TEXT", options: null, required: true, is_active: true, sort_order: 10, locked: false, is_custom: false, note: null },
    ] as never);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    const row = (await screen.findByText("LD-1")).closest("tr")!;
    await ui.click(within(row).getByRole("button", { name: /转单/ }));
    const modal = screen.getByText("需求转单").closest(".ant-modal-content") as HTMLElement;
    await waitFor(() => expect(within(modal).getByLabelText("关联订单号")).toBeInTheDocument());
  });

  it("已关闭需求不渲染行内操作按钮", async () => {
    vi.mocked(catalog.leadsApi.list).mockResolvedValue([
      { id: 2, lead_no: "LD-2", customer_id: 1, request_type: "SELL_ACCOUNT", budget: null, target: "卖个号", status: "CLOSED" },
    ]);
    renderLight(<CustomerLeadPanel />, { user: "admin" });
    await screen.findByText("LD-2");
    expect(screen.queryByRole("button", { name: /转单/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /关闭/ })).toBeNull();
  });
});
