import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { InventoryPanel } from "@/business/inventory/InventoryPanel";
import { setupInventoryPanelMocks } from "@fixtures/InventoryPanel.test.fixtures";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/orderCashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/profitAllocation.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");
setupInventoryPanelMocks();

describe("InventoryPanel：库存凭证保留", () => {
  it.each(["admin", "operator"])("%s 的库存台账不提供物理删除入口", async (user) => {
    renderLight(<InventoryPanel />, { user });
    const row = (await screen.findByText("acc-1")).closest("tr") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "删除" })).toBeNull();
  });
});
