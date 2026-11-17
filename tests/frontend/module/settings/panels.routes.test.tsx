/**
 * 资金账户页签容器（PoolsAndRoutesPanel）+ 设置导航注册表。
 * 2026-11-17 删除业务↔池过账路由后，容器只承载「资金账户定义」视图，不再有「过账路由」页签。
 */
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { poolsApi } from "@/shared/api/pools.api";
import { PoolsAndRoutesPanel } from "@/field-definitions/panels/PoolsAndRoutesPanel";
import { CONFIG_CENTER_GROUP_ORDER, SETTINGS_TAB_ORDER } from "@/field-definitions/configCatalog";

vi.mock("@/shared/api/pools.api");

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

describe("PoolsAndRoutesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(poolsApi.list).mockResolvedValue([
      { id: 1, code: "HJ_CUSTODY", name: "托管账户", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE", is_default: true },
    ] as never);
  });

  it("渲染资金账户定义视图并加载账户列表", async () => {
    renderLight(<PoolsAndRoutesPanel />, { user: "admin" });

    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    expect(await screen.findByText("资金账户主数据")).toBeInTheDocument();
  });
});
