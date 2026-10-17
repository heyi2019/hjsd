import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../test/render";
import { PolicySettingsPanel } from "../../policy/PolicySettingsPanel";
import { FieldsPanel } from "./FieldsPanel";
import { PoolsPanel } from "./PoolsPanel";

const { poolsApi, fieldsApi, policyApi } = vi.hoisted(() => ({
  poolsApi: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
  fieldsApi: { list: vi.fn(), create: vi.fn(), setActive: vi.fn(), remove: vi.fn() },
  policyApi: {
    list: vi.fn(),
    versions: vi.fn(),
    approve: vi.fn(),
    create: vi.fn(),
    createVersion: vi.fn(),
    updateDraft: vi.fn(),
    resolve: vi.fn(),
    allocations: vi.fn(),
  },
}));

vi.mock("../../shared/api/catalog", () => ({ poolsApi, fieldsApi, policyApi }));

const pools = [
  { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE" },
];
const fields = [
  { id: 1, entity_type: "ORDER", field_key: "region", label: "区域", field_type: "TEXT", is_active: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  poolsApi.list.mockResolvedValue(pools);
  fieldsApi.list.mockResolvedValue(fields);
  policyApi.list.mockResolvedValue({ items: [], total: 0 });
  policyApi.versions.mockResolvedValue({ items: [], total: 0 });
});

describe("设置面板：资金池", () => {
  it("admin 可见新增资金池入口", async () => {
    renderApp(<PoolsPanel />, { user: "admin" });
    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新增资金池/ })).toBeInTheDocument();
  });

  it("viewer 无 pool.manage 时显示只读回退且无新增按钮", async () => {
    renderApp(<PoolsPanel />, { user: "viewer" });
    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    expect(screen.getByText("当前角色无主数据维护权限。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新增资金池/ })).toBeNull();
  });

  it("admin 可编辑资金池名称、用途和归属", async () => {
    poolsApi.update.mockResolvedValue({ ...pools[0], name: "新托管池" });
    renderApp(<PoolsPanel />, { user: "admin" });
    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /编辑/ }));
    const dialog = screen.getByRole("dialog", { name: /编辑资金池/ });
    const name = within(dialog).getAllByRole("textbox")[1];
    await userEvent.clear(name);
    await userEvent.type(name, "新托管池");
    await userEvent.click(within(dialog).getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(poolsApi.update).toHaveBeenCalledWith(1, expect.objectContaining({ name: "新托管池", pool_type: "OTHER", ownership: "OWNED" })));
  });
});

describe("设置面板：活字段", () => {
  it("viewer 无管理权限时隐藏字段操作", async () => {
    renderApp(<FieldsPanel />, { user: "viewer" });
    expect(await screen.findByText("区域")).toBeInTheDocument();
    const labels = screen.queryAllByRole("button").map((button) => button.textContent ?? "");
    expect(labels.some((text) => text.includes("启用") || text.includes("停用"))).toBe(false);
    expect(screen.queryByRole("button", { name: /删\s*除/ })).toBeNull();
  });

  it("admin 可删除字段并刷新列表", async () => {
    renderApp(<FieldsPanel />, { user: "admin" });
    expect(await screen.findByText("区域")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /删\s*除/ }));
    await userEvent.click(await screen.findByRole("button", { name: /确\s*定|OK/ }));
    await waitFor(() => expect(fieldsApi.remove).toHaveBeenCalledWith(1));
    await waitFor(() => expect(fieldsApi.list).toHaveBeenCalledTimes(2));
  });

  it("TEXT 类型不展开选项输入，提交回传定义字段", async () => {
    renderApp(<FieldsPanel />, { user: "admin" });
    expect(await screen.findByText("区域")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/逗号分隔/)).toBeNull();
    await userEvent.type(screen.getByPlaceholderText("小写下划线，如 credit_level"), "credit_level");
    await userEvent.type(screen.getByPlaceholderText("页面显示名"), "信用评级");
    await userEvent.click(screen.getByRole("button", { name: /新增字段/ }));
    await waitFor(() => expect(fieldsApi.create).toHaveBeenCalled());
    expect(fieldsApi.create.mock.calls[0][0]).toMatchObject({
      entity_type: "customer",
      field_key: "credit_level",
      label: "信用评级",
      field_type: "TEXT",
      required: false,
      sort_order: 0,
    });
  });
});

describe("设置面板：经营规则", () => {
  it("挂载后渲染规则统计并加载定义", async () => {
    renderApp(<PolicySettingsPanel />, { user: "admin" });
    expect(await screen.findByText("规则总数")).toBeInTheDocument();
    await waitFor(() => expect(policyApi.list).toHaveBeenCalled());
  });
});
