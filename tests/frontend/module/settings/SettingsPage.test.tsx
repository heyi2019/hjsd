import { gameTypesApi } from "@/shared/api/misc.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { orderFormFieldsApi, orderTypesApi } from "@/shared/api/orders.api";
import { poolsApi } from "@/shared/api/pools.api";
import type { Pool } from "@/shared/api/types/finance";
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
import * as client from "@/shared/api/client";
vi.mock("@/shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/client")>()),
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  login: vi.fn(),
  logout: vi.fn(),
  setDevUser: vi.fn(),
  changePassword: vi.fn(),
  checkBackendHealth: vi.fn(),
}));
import { renderLight } from "@fixtures/render";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPage } from "@/settings/SettingsPage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listResponse, optionSetList } from "@fixtures/api-responses";

const orderTypes = [
  { id: 1, code: "HS", name: "回收", is_active: true },
] as unknown as import("@/shared/api/types/orders").OrderType[];

const pools = [
  { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", status: "ACTIVE" },
] as unknown as import("@/shared/api/types/finance").Pool[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(orderTypesApi.list).mockResolvedValue(orderTypes);
  vi.mocked(poolsApi.list).mockResolvedValue(pools);
  vi.mocked(optionSetsApi.list).mockResolvedValue(optionSetList());
  vi.mocked(gameTypesApi.list).mockResolvedValue([]);
  vi.mocked(orderFormFieldsApi.list).mockResolvedValue([]);
  vi.mocked(client.api).get.mockResolvedValue({ data: [] });
});

it("业务字典按账号流转、资金动作和账务动作三层结构渲染", async () => {
  renderLight(<SettingsPage />, { user: "admin" });

  // 三层分组结构渲染（结构断言，不锁具体文案）
  expect(document.querySelectorAll(".business-dictionary__group").length).toBeGreaterThanOrEqual(3);
  // 动作行数量健康，防止整段误删
  expect(document.querySelectorAll(".business-dictionary__action-line").length).toBeGreaterThan(10);
});

it("业务字典在分润规则下方展示取消模型", async () => {
  renderLight(<SettingsPage />, { user: "admin" });

  const profitRule = await screen.findByText("分润规则");
  const cancellationModel = screen.getByText("取消模型");
  expect(profitRule.compareDocumentPosition(cancellationModel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("回收/提号未售出")).toBeInTheDocument();
  expect(screen.getByText("已售出")).toBeInTheDocument();
});

it("业务字典展示账号入库规则：未售出禁止重复，已售出允许回流复购", () => {
  renderLight(<SettingsPage />, { user: "admin" });

  expect(screen.getByText("入库规则")).toBeInTheDocument();
  expect(screen.getByText(/只要历史账号仍未售出，就禁止重复入库/)).toBeInTheDocument();
  expect(screen.getByText(/历史账号已售出后，重复建单视为账号回流/)).toBeInTheDocument();
  expect(
    screen.getByText("取消模型").compareDocumentPosition(screen.getByText("入库规则")) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("订单导入预检与所选文件和选项绑定，改变选项后必须重新预检", async () => {
  const ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.mocked(client.api).post.mockResolvedValueOnce({ data: {
    rows: [{ sheet: "主订单信息", row: 2, order_no: "HS0981", action: "create", errors: [], warnings: [] }],
    available_sections: { events: 1 }, selected_sections: ["events"], detail_errors: [],
  } });
  renderLight(<SettingsPage />, { user: "admin" });
  await ui.click(screen.getByRole("tab", { name: "订单导入" }));
  await ui.upload(screen.getByLabelText("选择订单文件"), new File(["订单号"], "订单.csv", { type: "text/csv" }));
  await ui.click(screen.getByRole("radio", { name: "带详情导入" }));
  await ui.click(screen.getByRole("checkbox", { name: "操作明细" }));
  await ui.click(screen.getByRole("radio", { name: "更新已有订单" }));
  await ui.click(screen.getByRole("button", { name: "预检文件" }));
  expect(await screen.findByText("HS0981")).toBeInTheDocument();
  const [path, form] = vi.mocked(client.api).post.mock.calls[0];
  expect(path).toBe("/order-imports/preview");
  expect((form as FormData).get("existing")).toBe("update");
  expect((form as FormData).getAll("sections")).toEqual(["events"]);
  expect(screen.getByRole("button", { name: "确认导入" })).toBeEnabled();
  await ui.click(screen.getByRole("radio", { name: "跳过已有订单" }));
  expect(screen.queryByText("HS0981")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
});

it("订单导入展示预检错误并禁止执行，通过后显示实际写入结果", async () => {
  const ui = userEvent.setup({ pointerEventsCheck: 0 });
  const row = { sheet: "主订单信息", row: 2, order_no: "DG0981", action: "error", errors: ["业务日期无效"], warnings: [] };
  vi.mocked(client.api).post
    .mockResolvedValueOnce({ data: { rows: [row], available_sections: {}, selected_sections: [], detail_errors: [] } })
    .mockResolvedValueOnce({ data: { rows: [{ ...row, action: "create", errors: [] }], available_sections: {}, selected_sections: [], detail_errors: [] } })
    .mockResolvedValueOnce({ data: { created: 1, updated: 0, skipped: 0, events_created: 0, events_matched: 0, cashflows_created: 0, cashflows_matched: 0, cashflows_renumbered: [], rebates_created: 0, rebates_updated: 0 } });
  renderLight(<SettingsPage />, { user: "admin" });
  await ui.click(screen.getByRole("tab", { name: "订单导入" }));
  await ui.upload(screen.getByLabelText("选择订单文件"), new File(["订单号"], "订单.csv", { type: "text/csv" }));
  await ui.click(screen.getByRole("button", { name: "预检文件" }));
  expect(await screen.findByText("业务日期无效")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
  await ui.click(screen.getByRole("button", { name: "预检文件" }));
  await ui.click(await screen.findByRole("button", { name: "确认导入" }));
  expect(await screen.findByText(/新建 1.*更新 0.*跳过 0/)).toBeInTheDocument();
  expect(vi.mocked(client.api).post.mock.calls[2][0]).toBe("/order-imports/execute");
});

it("更改导入选项后，迟到的旧预检结果不能重新启用导入", async () => {
  const ui = userEvent.setup({ pointerEventsCheck: 0 });
  let resolvePreview!: (value: unknown) => void;
  vi.mocked(client.api).post.mockImplementationOnce(() => new Promise((resolve) => { resolvePreview = resolve; }) as never);
  renderLight(<SettingsPage />, { user: "admin" });
  await ui.click(screen.getByRole("tab", { name: "订单导入" }));
  await ui.upload(screen.getByLabelText("选择订单文件"), new File(["订单号"], "订单.csv", { type: "text/csv" }));
  await ui.click(screen.getByRole("button", { name: "预检文件" }));
  await ui.click(screen.getByRole("radio", { name: "更新已有订单" }));
  await act(async () => resolvePreview({ data: {
    rows: [{ sheet: "主订单信息", row: 2, order_no: "HS0981", action: "create", errors: [], warnings: [] }],
    available_sections: {}, selected_sections: [], detail_errors: [],
  } }));
  expect(screen.queryByText("HS0981")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
});
