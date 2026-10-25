/** OrderFormFieldsPanel 交互测试：挂载拉取、新增、停用、删除、核心字段禁用。 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { message } from "antd";
import * as catalog from "../../shared/api/catalog";
vi.mock("../../shared/api/catalog");
import * as client from "../../shared/api/client";
import { renderLight } from "../../test/render";
import { OrderFormFieldsPanel } from "./OrderFormFieldsPanel";

vi.mock("../../shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/api/client")>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  login: vi.fn(),
  logout: vi.fn(),
  setDevUser: vi.fn(),
  changePassword: vi.fn(),
  checkBackendHealth: vi.fn(),
}));

type Field = catalog.OrderFormField;

const makeField = (over: Partial<Field> = {}): Field => ({
  id: 1,
  order_type_code: "HS",
  field_key: "k",
  label: "字段",
  field_type: "TEXT",
  options: null,
  required: false,
  is_active: true,
  sort_order: 0,
  locked: false,
  is_custom: true,
  note: null,
  ...over,
});

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.spyOn(message, "success").mockImplementation(() => ({}) as never);
  vi.spyOn(message, "error").mockImplementation(() => ({}) as never);
  vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([]);
});

describe("OrderFormFieldsPanel", () => {
  it("挂载时按当前业务类型拉取字段列表", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 10, field_key: "tag", label: "自定义标签A", locked: false, is_custom: true }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    expect(await screen.findByText("自定义标签A")).toBeInTheDocument();
    expect(vi.mocked(catalog.orderFormFieldsApi).list).toHaveBeenCalledWith("HS", true);
  });

  it("新增自定义字段调用 create 并刷新列表", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("该表单暂无字段配置");

    await ui.type(screen.getByLabelText("字段键"), "vip_tag");
    await ui.type(screen.getByLabelText("标签"), "VIP标签");
    await ui.click(screen.getByRole("button", { name: /新增字段/ }));

    await waitFor(() =>
      expect(vi.mocked(catalog.orderFormFieldsApi).create).toHaveBeenCalled(),
    );
    const payload = vi.mocked(catalog.orderFormFieldsApi).create.mock.calls[0][0] as Partial<Field>;
    expect(payload.field_key).toBe("vip_tag");
    expect(payload.label).toBe("VIP标签");
    expect(payload.order_type_code).toBe("HS");
  });

  it("停用非核心字段调用 setActive(false)", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 20, field_key: "tag", label: "可停用字段", locked: false, is_custom: true, is_active: true }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("可停用字段");

    await ui.click(screen.getByText("停用"));
    await ui.click(await screen.findByRole("button", { name: /确认/ }));

    await waitFor(() =>
      expect(vi.mocked(catalog.orderFormFieldsApi).setActive).toHaveBeenCalledWith(20, false),
    );
  });

  it("核心字段删除按钮禁用", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 30, field_key: "core", label: "核心字段X", locked: true, is_custom: false }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("核心字段X");
    expect(screen.getByRole("button", { name: /删除/ })).toBeDisabled();
  });

  it("核心字段编辑按钮禁用", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 31, field_key: "core", label: "核心字段Y", locked: true }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("核心字段Y");
    expect(screen.getByRole("button", { name: /编辑核心字段Y/ })).toBeDisabled();
  });

  it("删除自定义字段调用 remove", async () => {
    vi.mocked(catalog.orderFormFieldsApi).list.mockResolvedValue([
      makeField({ id: 40, field_key: "c1", label: "自定义字段Z", locked: false, is_custom: true }),
    ]);
    renderLight(<OrderFormFieldsPanel />, { user: "admin" });
    await screen.findByText("自定义字段Z");

    await ui.click(screen.getByText("删除"));
    await ui.click(await screen.findByRole("button", { name: /OK/ }));

    await waitFor(() =>
      expect(vi.mocked(catalog.orderFormFieldsApi).remove).toHaveBeenCalledWith(40),
    );
  });
});
