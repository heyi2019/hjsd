import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { reconciliationRows, ui } from "@fixtures/financePageSetup";
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

describe("FinancePage：资金对账", () => {
  it("FE-230：对账失败时显示明确空态并禁用新增", async () => {
    vi.mocked(reconciliationRows).mockRejectedValueOnce(new Error("reconciliations down"));
    renderLight(<FinancePage />, { user: "admin" });
    await screen.findByRole("cell", { name: /经营主池/ });
    await ui.click(screen.getByRole("tab", { name: "对账" }));

    expect(await screen.findByText("资金对账数据不可用，请点击重新加载")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新增对账/ })).toBeDisabled();
  });

});
