import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { ui } from "@fixtures/financePageSetup";
import { FinancePage } from "@/finance/FinancePage";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/deposits.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/profitAllocation.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/reconciliations.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;
vi.mock("@/shared/api/transfers.api");
vi.mock("@/shared/api/studioExpenses.api");

describe("FinancePage：押金占用", () => {
  it("押金损失金额缺失时显示未知，不当成零", async () => {
    renderLight(<FinancePage />, { user: "admin" });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    const cell = await screen.findByText("#99");
    const row = cell.closest("tr") as HTMLElement;
    const headings = screen.getAllByRole("columnheader").map((heading) => heading.textContent);
    const index = headings.findIndex((heading) => heading === "已损失");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(within(row).getAllByRole("cell")[index]).toHaveTextContent("-");
    await ui.click(within(row).getByRole("button", { name: "释放" }));
    const dialog = await screen.findByRole("dialog", { name: "押金释放" });
    expect(dialog).toHaveTextContent(/已损失\s*-/);
  });

  it("押金板块作为独立入口保留业务资金口径", async () => {
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });

    await ui.click(screen.getByRole("tab", { name: "押金" }));
    // 断言「押金占用」这一整块（卡片标题 + 新增入口）落在资金中心独立入口内，而不是靠
    // 别处（如已卸载的总览 StatRow）凑出现次数。Tabs 开了 destroyOnHidden，未激活面板
    // 不会留在 DOM，故此处必须是面板内的唯一一份。
    const depositPanel = await screen.findByRole("tabpanel", { name: "押金" });
    expect(within(depositPanel).getByText("押金占用")).toBeInTheDocument();
    expect(within(depositPanel).getByRole("button", { name: /新增占用/ })).toBeInTheDocument();
  });

  it("押金列表渲染金额与剩余（占用-已释放）", async () => {
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    expect(screen.queryByText("押金编号")).not.toBeInTheDocument();
    expect(screen.getAllByText("300.00").length).toBeGreaterThanOrEqual(1); // 500-200
  });

  it("押金明细展示对手方、来源订单和预计释放日", async () => {
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "押金" }));
    expect(screen.getByText("#99")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
    expect(screen.getByText("2026-11-01")).toBeInTheDocument();
  });
});
