import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";
import { seedOptionSets } from "../../test/formFieldsSeed";

import * as catalog from "../../shared/api/catalog";
import type { OrderType, OrderTypeRoute, Pool } from "../../shared/api/catalog";
vi.mock("../../shared/api/catalog");

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
    seedOptionSets(catalog);
    vi.mocked(catalog.orderTypesApi).list.mockResolvedValue(TYPES);
    vi.mocked(catalog.orderTypesApi).routes.mockImplementation((id: number) =>
      Promise.resolve(ROUTES[id] ?? []),
    );
    vi.mocked(catalog.poolsApi).list.mockResolvedValue(POOLS);
  });

  it("跨业务类型摊平路由：两条路由与目标池同屏可见", async () => {
    const { OrderTypeRoutesPanel } = await import("./OrderTypeRoutesPanel");
    renderLight(<OrderTypeRoutesPanel />, { user: "admin" });

    expect(await screen.findByText("资金路由一览")).toBeInTheDocument();
    // 两个业务类型各自一行，目标池来自 pool_name + pool_code
    expect(screen.getAllByText("投资款荷包（HJ_INVEST）").length).toBe(2);
    // 业务类型列展示「名称（代码）」
    expect(screen.getByText("回收（HS）")).toBeInTheDocument();
    expect(screen.getByText("代挂（DG）")).toBeInTheDocument();
  });

  it("份额与资金性质文案来自选项词典；不限性质显示「不限」", async () => {
    const { OrderTypeRoutesPanel } = await import("./OrderTypeRoutesPanel");
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

  it("单个业务类型路由拉取失败只丢该类型，不整页报错", async () => {
    vi.mocked(catalog.orderTypesApi).routes.mockImplementation((id: number) =>
      id === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(ROUTES[id] ?? []),
    );
    const { OrderTypeRoutesPanel } = await import("./OrderTypeRoutesPanel");
    renderLight(<OrderTypeRoutesPanel />, { user: "admin" });

    await waitFor(() => expect(screen.getByText("代挂（DG）")).toBeInTheDocument());
    expect(screen.queryByText("回收（HS）")).toBeNull();
    // 错误横幅不出现（逐类型容错，失败静默降级）
    expect(screen.queryByRole("button", { name: /重试/ })).toBeNull();
  });
});
