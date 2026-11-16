/**
 * 资金池页签容器 + 资金路由页——由 2 个碎片文件合并：
 *   OrderTypeRoutesPanel.test.tsx / PoolsAndRoutesPanel.test.tsx
 * 合并动因同上（文件级固定成本）；用例与断言逐条保留，各自 describe 隔离。
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { seedOptionSets } from "@fixtures/formFieldsSeed";
import { orderTypesApi } from "@/shared/api/orders.api";
import { poolsApi } from "@/shared/api/pools.api";
import type { Pool } from "@/shared/api/types/finance";
import type { OrderType, OrderTypeRoute } from "@/shared/api/types/orders";
import { OrderTypeRoutesPanel } from "@/field-definitions/panels/OrderTypeRoutesPanel";
import { PoolsAndRoutesPanel } from "@/field-definitions/panels/PoolsAndRoutesPanel";
import { CONFIG_CENTER_GROUP_ORDER, SETTINGS_TAB_ORDER } from "@/field-definitions/configCatalog";

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

const TYPES = [
  { id: 1, code: "HS", name: "回收", capital_type: "STOCK", is_active: true },
  { id: 2, code: "DG", name: "代挂", capital_type: "ZERO", is_active: true },
] as unknown as OrderType[];

const POOLS = [
  { id: 1, code: "HJ_INVEST", name: "投资款荷包", pool_type: "INVEST", ownership: "OWNED", status: "ACTIVE" },
] as unknown as Pool[];

const ROUTES: Record<number, OrderTypeRoute[]> = {
  1: [
    { id: 11, order_type_code: "HS", portion: "PRINCIPAL", fund_nature: null, pool_code: "HJ_INVEST", pool_name: "投资款荷包", priority: 0, is_active: true },
  ],
  2: [
    { id: 21, order_type_code: "DG", portion: "GROSS", fund_nature: "BUSINESS", pool_code: "HJ_INVEST", pool_name: "投资款荷包", priority: 5, is_active: true },
  ],
};

describe("OrderTypeRoutesPanel 资金路由页", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedOptionSets();
    vi.mocked(orderTypesApi).list.mockResolvedValue(TYPES);
    vi.mocked(orderTypesApi).routes.mockImplementation((id: number) =>
      Promise.resolve(ROUTES[id] ?? []),
    );
    vi.mocked(poolsApi).list.mockResolvedValue(POOLS);
  });

  it("跨业务类型摊平路由：两条路由与目标池同屏可见", async () => {
    renderLight(<OrderTypeRoutesPanel />, { user: "admin" });

    expect(await screen.findByText("资金路由一览")).toBeInTheDocument();
    // 两个业务类型各自一行，目标池来自 pool_name + pool_code
    expect(screen.getAllByText("投资款荷包（HJ_INVEST）").length).toBe(2);
    // 业务类型列展示「名称（代码）」
    expect(screen.getByText("回收（HS）")).toBeInTheDocument();
    expect(screen.getByText("代挂（DG）")).toBeInTheDocument();
  });

  it("FE-262：过账路由业务类型下拉包含代挂 DG", async () => {
    renderLight(<OrderTypeRoutesPanel />, { user: "admin" });

    await userEvent.click(screen.getByRole("combobox", { name: "业务类型" }));
    expect(await screen.findByText("代挂（DG）", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("份额与资金性质文案来自选项词典；不限性质显示「不限」", async () => {
    renderLight(<OrderTypeRoutesPanel />, { user: "admin" });

    await screen.findByText("回收（HS）");
    // 断言限定在表格内：页面下方的「覆盖资金路由」表单也有份额下拉，
    // 会与表格文案重复（getByText 会报 multiple elements）。
    const table = screen.getByRole("table");
    // ROUTE_PORTION 词典：PRINCIPAL=本金、GROSS=总额
    expect(within(table).getByText("本金")).toBeInTheDocument();
    expect(within(table).getByText("总额")).toBeInTheDocument();
    // fund_nature 为空 → 不限；有值 → ROUTE_FUND_NATURE 词典文案
    expect(within(table).getByText("不限")).toBeInTheDocument();
    expect(within(table).getByText("本方经营")).toBeInTheDocument();
  });

  it("FE-240：路由读取失败进入错误态并锁定覆盖保存", async () => {
    vi.mocked(orderTypesApi).routes.mockImplementation((id: number) =>
      id === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(ROUTES[id] ?? []),
    );
    renderLight(<OrderTypeRoutesPanel />, { user: "admin" });

    expect((await screen.findAllByText("资金路由数据不可用，请点击重新加载")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /保存路由/ })).toBeDisabled();
    expect(screen.getByText(/业务类型覆盖不可用/)).toBeInTheDocument();
  });
});

describe("设置导航注册表", () => {
  it("设置页与配置中心共用单一导航顺序", () => {
    expect(SETTINGS_TAB_ORDER).toEqual([
      "business-dictionary",
      "organization",
      "audit",
      "appearance",
    ]);
    expect(CONFIG_CENTER_GROUP_ORDER).toEqual(["FIELD", "MASTER", "BUSINESS", "SEQUENCE"]);
    expect(new Set(SETTINGS_TAB_ORDER).size).toBe(SETTINGS_TAB_ORDER.length);
  });
});

/** 资金池页签容器：验证「池定义 / 过账路由」两个视图的默认值与切换后按需挂载。
 *
 * 合并前的两个 Tab 各有独立测试（PoolsPanel / OrderTypeRoutesPanel），本 describe 只锁
 * 容器行为：默认落在池定义、切换后才去拉路由数据（避免合并成一个页签后一次性双请求）。
 */
describe("PoolsAndRoutesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(poolsApi).list.mockResolvedValue([
      { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE" },
    ] as never);
    vi.mocked(orderTypesApi).list.mockResolvedValue([
      { id: 1, code: "HS", name: "回收", capital_type: "OWNED", is_active: true },
    ] as never);
    vi.mocked(orderTypesApi).routes.mockResolvedValue([
      {
        order_type_code: "HS",
        portion: "PRINCIPAL",
        pool_code: "HJ_CUSTODY",
        pool_name: "托管池",
        fund_nature: null,
        priority: 0,
        is_active: true,
      },
    ] as never);
  });

  it("默认进入资金池定义视图，且不预先请求路由数据", async () => {
    renderLight(<PoolsAndRoutesPanel />, { user: "admin" });

    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    expect(orderTypesApi.routes).not.toHaveBeenCalled();
  });

  it("切到过账路由视图才渲染路由表并请求路由数据", async () => {
    const user = userEvent.setup();
    renderLight(<PoolsAndRoutesPanel />, { user: "admin" });
    await screen.findByText("HJ_CUSTODY");

    await user.click(screen.getByText("过账路由"));

    expect(await screen.findByText("资金路由一览")).toBeInTheDocument();
    await waitFor(() => expect(orderTypesApi.routes).toHaveBeenCalledWith(1));
    // 切换后池定义视图卸载，避免两套表格同时存在。
    expect(screen.queryByText("资金池主数据")).toBeNull();
  });
});
