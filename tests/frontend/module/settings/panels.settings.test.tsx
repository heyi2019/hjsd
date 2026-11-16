/**
 * 设置面板（资金池 / 游戏类型）——由 3 个碎片文件合并而来：
 *   SettingsPanels.test.tsx / PoolsPanel.test.tsx / GameTypeSettingsPanel.test.tsx
 * 合并动因：每个测试文件都要走一遍模块图加载与 transform（实测约 2s/文件），
 * 与本文件用例数无关；合并只减少文件数，用例与断言逐条保留（各自 describe 隔离）。
 */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { gameTypesApi } from "@/shared/api/misc.api";
import { policyApi } from "@/shared/api/policy.api";
import { poolsApi } from "@/shared/api/pools.api";
import { PoolsPanel } from "@/field-definitions/panels/PoolsPanel";
import { GameTypeSettingsPanel } from "@/field-definitions/panels/GameTypeSettingsPanel";
import { listResponse } from "@fixtures/api-responses";

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

let ui: ReturnType<typeof userEvent.setup>;

const pools = [
  { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE" },
];

beforeEach(() => {
  vi.clearAllMocks();
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.mocked(poolsApi).list.mockResolvedValue(pools);
  vi.mocked(policyApi).list.mockResolvedValue(listResponse([]));
  vi.mocked(policyApi).versions.mockResolvedValue(listResponse([]));
  vi.mocked(gameTypesApi).list.mockResolvedValue([
    { id: 1, name: "王者荣耀", sort_order: 10, is_active: true, is_default: true },
    { id: 2, name: "原神", sort_order: 20, is_active: true, is_default: false },
  ]);
});

afterEach(cleanup);

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
    vi.mocked(poolsApi).update.mockResolvedValue({ ...pools[0], name: "新托管池" });
    renderLight(<PoolsPanel />, { user: "admin" });
    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /编辑/ }));
    const dialog = screen.getByRole("dialog", { name: /编辑资金池/ });
    const name = within(dialog).getAllByRole("textbox")[1];
    await ui.clear(name);
    await ui.type(name, "新托管池");
    await ui.click(within(dialog).getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(vi.mocked(poolsApi).update).toHaveBeenCalledWith(1, expect.objectContaining({ name: "新托管池", pool_type: "OTHER", ownership: "OWNED" })));
  });
});

describe("PoolsPanel：失败态与空态", () => {
  it("shows pool configuration without the removed pool account feature", async () => {
    renderLight(<PoolsPanel />, { user: "admin" });

    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    expect(screen.queryByText("资金池账户")).not.toBeInTheDocument();
  });

  it("编辑资金池保存失败时弹窗内显示错误且不关闭（L1801）", async () => {
    const local = userEvent.setup();
    vi.mocked(poolsApi).update.mockRejectedValue(new Error("资金池保存失败"));
    renderLight(<PoolsPanel />, { user: "admin" });
    await screen.findByText("HJ_CUSTODY");

    await local.click(screen.getByText("编辑"));
    expect(await screen.findByText("编辑资金池 · HJ_CUSTODY")).toBeInTheDocument();
    await local.click(screen.getByText("保存"));

    // 编辑弹窗内即时显示错误，用户无需关闭弹窗去页面顶部找错误（限定弹窗体，避开页面级 ErrorBanner 的同文案）
    const modalBody = document.querySelector(".ant-modal-body") as HTMLElement;
    expect(await within(modalBody).findByText(/资金池保存失败/)).toBeInTheDocument();
    // 弹窗保持打开，保留已填表单供修正
    expect(screen.getByText("编辑资金池 · HJ_CUSTODY")).toBeInTheDocument();
    // 失败不触发列表重载，避免覆盖错误态
    expect(vi.mocked(poolsApi).list).toHaveBeenCalledTimes(1);
  });

  it("FE-239：资金池主数据失败时显示错误空态并禁用新增", async () => {
    vi.mocked(poolsApi).list.mockRejectedValueOnce(new Error("pools down"));
    renderLight(<PoolsPanel />, { user: "admin" });

    expect(await screen.findByText("资金池数据不可用，请点击重新加载")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新增资金池/ })).toBeDisabled();
  });
});

describe("设置面板：游戏类型", () => {
  it("展示游戏类型并可勾选默认游戏类型", async () => {
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    expect(await screen.findByText("王者荣耀")).toBeInTheDocument();
    await ui.click(screen.getByRole("checkbox", { name: "原神设为默认" }));

    await waitFor(() => expect(vi.mocked(gameTypesApi).setDefault).toHaveBeenCalledWith(2, true));
  });

  it("管理员可新增游戏类型", async () => {
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    await screen.findByText("王者荣耀");
    await ui.type(screen.getByPlaceholderText("如：王者荣耀"), "和平精英");
    await ui.click(screen.getByRole("button", { name: /新增游戏类型/ }));

    await waitFor(() => expect(vi.mocked(gameTypesApi).create).toHaveBeenCalledWith({ name: "和平精英", sort_order: 0, channel_regions: [] }));
  });

  it("管理员可编辑游戏类型名称和排序", async () => {
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    await screen.findByText("王者荣耀");
    await ui.click(screen.getByRole("button", { name: "编辑王者荣耀" }));
    await ui.clear(screen.getByPlaceholderText("如：王者荣耀"));
    await ui.type(screen.getByPlaceholderText("如：王者荣耀"), "王者荣耀手游");
    await ui.click(screen.getByRole("button", { name: /保存游戏类型/ }));

    await waitFor(() => expect(vi.mocked(gameTypesApi).update).toHaveBeenCalledWith(1, {
      name: "王者荣耀手游",
      sort_order: 10,
      channel_regions: [],
    }));
  });
});

describe("GameTypeSettingsPanel：表单细节", () => {
  beforeEach(() => {
    vi.mocked(gameTypesApi).list.mockResolvedValue([]);
  });

  it("does not let browser form-history values appear as game type suggestions", async () => {
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    const input = await screen.findByPlaceholderText("如：王者荣耀");
    expect(input).toHaveAttribute("name", "game_type_name");
    expect(input).toHaveAttribute("autocomplete", "off");
  });

  it("新建时勾选默认类型 → payload 带 is_default（后端 create 支持，edit 不传）", async () => {
    vi.mocked(gameTypesApi).create.mockResolvedValue({ id: 3, name: "蛋仔派对", sort_order: 0, is_active: true, is_default: true });
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    await ui.type(await screen.findByPlaceholderText("如：王者荣耀"), "蛋仔派对");
    await ui.click(screen.getByRole("checkbox", { name: /新建表单自动带出/ }));
    await ui.click(screen.getByRole("button", { name: /新增游戏类型/ }));
    await waitFor(() => expect(vi.mocked(gameTypesApi).create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "蛋仔派对", is_default: true }),
    ));
  });
});
