import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { DashboardPage } from "./DashboardPage";

import * as catalog from "../shared/api/catalog";
import { seedOrderFormFields } from "../test/formFieldsSeed";
/** 2026-10-13：工作台数据总览（资金池/统计/入口卡）已迁至「经营中心 · 数据中心」
 *  （用例见 reporting/DataCenterPanel.test.tsx）。本文件只覆盖瘦身后的工作台：
 *  纯动作入口——新建业务卡 + 登记弹窗，以及「数据已迁走」的回归断言。 */

vi.mock("../shared/api/catalog")

beforeEach(() => {
  vi.clearAllMocks();
  seedOrderFormFields(catalog);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([]);
  vi.mocked(catalog.reportsApi.commission).mockResolvedValue({
    items: [],
    total: { order_count: 0, profit_base: "0.00", payable: "0.00", paid: "0.00", difference: "0.00" },
  });
});

describe("DashboardPage：动作入口（数据已迁数据中心）", () => {
it("admin 渲染业务入口卡", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    expect(await screen.findByRole("button", { name: /自营·回收/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /售出库存账号/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提号" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "代挂" })).toBeInTheDocument();
  });

it("工作台只保留标题和入口，不显示辅助描述文字", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /自营·回收/ });
    expect(screen.queryByText("先处理最重要的动作；业务数据与经营指标分别在对应中心查看。")).toBeNull();
    expect(screen.queryByText("回收 / 提号 / 代挂 库存账号的统一出售入口")).toBeNull();
    expect(screen.queryByText("从库存中心选择任意渠道（回收 / 提号 / 代挂）的账号售出")).toBeNull();
    expect(screen.queryByText("录入游戏账号、来源与回收费用，创建回收单")).toBeNull();
    expect(screen.queryByText("需要快速开始时，从一个明确动作开始。")).toBeNull();
  });

it("业务入口按场景使用独立的卡片视觉层级", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /自营·回收/ });
    expect(document.querySelector(".dashboard-entry-group--sell")).toBeInTheDocument();
    expect(document.querySelector(".dashboard-entry-group--self-owned")).toBeInTheDocument();
    expect(document.querySelector(".dashboard-entry-group--distribution")).toBeInTheDocument();
  });

it("所有业务分组都不显示顶部装饰条", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: "提号" });
    const groups = document.querySelectorAll(".dashboard-entry-group");
    expect(groups).toHaveLength(3);
    groups.forEach((group) => {
      expect(group).toHaveClass("dashboard-entry-group--no-accent");
    });
  });

it("分销入口使用中性白色视觉", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: "提号" });
    expect(document.querySelector(".dashboard-entry-group--distribution.dashboard-entry-group--neutral")).toBeInTheDocument();
  });

it("主入口展示短标签，强化业务转化层级", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: /售出库存账号/ });
    expect(screen.getByText("主推入口")).toBeInTheDocument();
    expect(screen.getByText("高频业务")).toBeInTheDocument();
  });

it("分销入口只显示业务名称，不重复显示分销前缀", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    expect(await screen.findByRole("button", { name: "提号" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "代挂" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分销·提号" })).toBeNull();
    expect(screen.queryByRole("button", { name: "分销·代挂" })).toBeNull();
  });

it("所有业务入口使用同一套标准化分组结构", async () => {
    renderLight(<DashboardPage />, { user: "admin" });
    await screen.findByRole("button", { name: "提号" });
    const groups = document.querySelectorAll(".dashboard-entry-group");
    expect(groups).toHaveLength(3);
    groups.forEach((group) => {
      expect(group.querySelector(":scope > .dashboard-entry-group__items")).toBeInTheDocument();
    });
  });

});
