/** 资金池页签容器：验证「池定义 / 过账路由」两个视图的默认值与切换后按需挂载。
 *
 * 合并前的两个 Tab 各有独立测试（PoolsPanel / OrderTypeRoutesPanel），本文件只锁
 * 容器行为：默认落在池定义、切换后才去拉路由数据（避免合并成一个页签后一次性双请求）。
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../../shared/api/catalog";
import { renderLight } from "../../test/render";
import { PoolsAndRoutesPanel } from "./PoolsAndRoutesPanel";

vi.mock("../../shared/api/catalog");

describe("PoolsAndRoutesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(catalog.poolsApi).list.mockResolvedValue([
      { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE" },
    ] as never);
    vi.mocked(catalog.orderTypesApi).list.mockResolvedValue([
      { id: 1, code: "HS", name: "回收", capital_type: "OWNED", is_active: true },
    ] as never);
    vi.mocked(catalog.orderTypesApi).routes.mockResolvedValue([
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
    expect(catalog.orderTypesApi.routes).not.toHaveBeenCalled();
  });

  it("切到过账路由视图才渲染路由表并请求路由数据", async () => {
    const user = userEvent.setup();
    renderLight(<PoolsAndRoutesPanel />, { user: "admin" });
    await screen.findByText("HJ_CUSTODY");

    await user.click(screen.getByText("过账路由"));

    expect(await screen.findByText("资金路由一览")).toBeInTheDocument();
    await waitFor(() => expect(catalog.orderTypesApi.routes).toHaveBeenCalledWith(1));
    // 切换后池定义视图卸载，避免两套表格同时存在。
    expect(screen.queryByText("资金池主数据")).toBeNull();
  });
});
