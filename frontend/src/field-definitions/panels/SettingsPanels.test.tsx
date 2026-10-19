import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../../shared/api/catalog";
vi.mock("../../shared/api/catalog");
import { renderLight } from "../../test/render";
import { FieldsPanel } from "./FieldsPanel";
import { PoolsPanel } from "./PoolsPanel";
import { resolveMock } from "../../test/mock-api";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});





const pools = [
  { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE" },
];
const fields = [
  { id: 1, entity_type: "ORDER", field_key: "region", label: "区域", field_type: "TEXT", is_active: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.poolsApi).list.mockResolvedValue(pools);
  resolveMock(vi.mocked(catalog.fieldsApi).list, fields);
  vi.mocked(catalog.policyApi).list.mockResolvedValue({ items: [], total: 0 });
  vi.mocked(catalog.policyApi).versions.mockResolvedValue({ items: [], total: 0 });
  vi.mocked(catalog.gameTypesApi).list.mockResolvedValue([
    { id: 1, name: "王者荣耀", sort_order: 10, is_active: true, is_default: true },
    { id: 2, name: "原神", sort_order: 20, is_active: true, is_default: false },
  ]);
});

describe("设置面板：资金池", () => {
  it("admin 可见新增资金池入口", async () => {
    renderLight(<PoolsPanel />, { user: "admin" });
    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新增资金池/ })).toBeInTheDocument();
  });

  it("viewer 无 pool.manage 时显示只读回退且无新增按钮", async () => {
    renderLight(<PoolsPanel />, { user: "viewer" });
    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    expect(screen.getByText("当前角色无主数据维护权限。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新增资金池/ })).toBeNull();
  });

  it("admin 可编辑资金池名称、用途和归属", async () => {
    vi.mocked(catalog.poolsApi).update.mockResolvedValue({ ...pools[0], name: "新托管池" });
    renderLight(<PoolsPanel />, { user: "admin" });
    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /编辑/ }));
    const dialog = screen.getByRole("dialog", { name: /编辑资金池/ });
    const name = within(dialog).getAllByRole("textbox")[1];
    await ui.clear(name);
    await ui.type(name, "新托管池");
    await ui.click(within(dialog).getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(vi.mocked(catalog.poolsApi).update).toHaveBeenCalledWith(1, expect.objectContaining({ name: "新托管池", pool_type: "OTHER", ownership: "OWNED" })));
  });

});

describe("设置面板：活字段", () => {
  it("viewer 无管理权限时隐藏字段操作", async () => {
    renderLight(<FieldsPanel />, { user: "viewer" });
    expect(await screen.findByText("区域")).toBeInTheDocument();
    const labels = screen.queryAllByRole("button").map((button) => button.textContent ?? "");
    expect(labels.some((text) => text.includes("启用") || text.includes("停用"))).toBe(false);
    expect(screen.queryByRole("button", { name: /删\s*除/ })).toBeNull();
  });

  it("admin 可删除字段并刷新列表", async () => {
    renderLight(<FieldsPanel />, { user: "admin" });
    expect(await screen.findByText("区域")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /删\s*除/ }));
    await ui.click(await screen.findByRole("button", { name: /确\s*定|OK/ }));
    await waitFor(() => expect(vi.mocked(catalog.fieldsApi).remove).toHaveBeenCalledWith(1));
    await waitFor(() => expect(vi.mocked(catalog.fieldsApi).list).toHaveBeenCalledTimes(2));
  });

  it("TEXT 类型不展开选项输入，提交回传定义字段", async () => {
    renderLight(<FieldsPanel />, { user: "admin" });
    expect(await screen.findByText("区域")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/逗号分隔/)).toBeNull();
    await ui.type(screen.getByPlaceholderText("小写下划线，如 credit_level"), "credit_level");
    await ui.type(screen.getByPlaceholderText("页面显示名"), "信用评级");
    await ui.click(screen.getByRole("button", { name: /新增字段/ }));
    await waitFor(() => expect(vi.mocked(catalog.fieldsApi).create).toHaveBeenCalled());
    expect(vi.mocked(catalog.fieldsApi).create.mock.calls[0][0]).toMatchObject({
      entity_type: "customer",
      field_key: "credit_level",
      label: "信用评级",
      field_type: "TEXT",
      required: false,
      sort_order: 0,
    });
  });

  it("管理员可编辑活字段标签和排序", async () => {
    const field = { ...fields[0], required: false, sort_order: 3 };
    vi.mocked(catalog.fieldsApi).list.mockResolvedValue([field]);
    const { FieldsPanel } = await import("./FieldsPanel");
    renderLight(<FieldsPanel />, { user: "admin" });

    await screen.findByText("区域");
    await ui.click(screen.getByRole("button", { name: "编辑区域" }));
    await ui.clear(screen.getByPlaceholderText("页面显示名"));
    await ui.type(screen.getByPlaceholderText("页面显示名"), "客户区域");
    await ui.click(screen.getByRole("button", { name: /保存字段/ }));

    await waitFor(() => expect(vi.mocked(catalog.fieldsApi).update).toHaveBeenCalledWith(1, {
      label: "客户区域",
      required: false,
      sort_order: 3,
    }));
  });
});

describe("设置面板：游戏类型", () => {
  it("展示游戏类型并可勾选默认游戏类型", async () => {
    const { GameTypeSettingsPanel } = await import("./GameTypeSettingsPanel");
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    expect(await screen.findByText("王者荣耀")).toBeInTheDocument();
    await ui.click(screen.getByRole("checkbox", { name: "原神设为默认" }));

    await waitFor(() => expect(vi.mocked(catalog.gameTypesApi).setDefault).toHaveBeenCalledWith(2, true));
  });

  it("管理员可新增游戏类型", async () => {
    const { GameTypeSettingsPanel } = await import("./GameTypeSettingsPanel");
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    await screen.findByText("王者荣耀");
    await ui.type(screen.getByPlaceholderText("如：王者荣耀"), "和平精英");
    await ui.click(screen.getByRole("button", { name: /新增游戏类型/ }));

    await waitFor(() => expect(vi.mocked(catalog.gameTypesApi).create).toHaveBeenCalledWith({ name: "和平精英", sort_order: 0 }));
  });

  it("管理员可编辑游戏类型名称和排序", async () => {
    const { GameTypeSettingsPanel } = await import("./GameTypeSettingsPanel");
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    await screen.findByText("王者荣耀");
    await ui.click(screen.getByRole("button", { name: "编辑王者荣耀" }));
    await ui.clear(screen.getByPlaceholderText("如：王者荣耀"));
    await ui.type(screen.getByPlaceholderText("如：王者荣耀"), "王者荣耀手游");
    await ui.click(screen.getByRole("button", { name: /保存游戏类型/ }));

    await waitFor(() => expect(vi.mocked(catalog.gameTypesApi).update).toHaveBeenCalledWith(1, {
      name: "王者荣耀手游",
      sort_order: 10,
    }));
  });
});
