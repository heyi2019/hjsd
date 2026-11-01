/** FundsPage.fragments：移动端流水卡片的冲销入口可见性（L1707）。 */
import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLight } from "../test/render";
import type { Cashflow } from "../shared/api/catalog";
import { MobileCashflowList } from "./FundsPage.fragments";

function makeRow(overrides: Partial<Cashflow> = {}): Cashflow {
  return {
    id: 1,
    flow_no: "CF-001",
    status: "APPROVED",
    pool_id: 1,
    occurred_on: "2026-10-20",
    nature: "BUSINESS_OUT",
    fund_nature: "BUSINESS",
    accounting_attribute: "OPERATING_EXPENSE",
    category: "房租",
    direction: "OUT",
    amount: "100.00",
    source: "OTHER",
    ...overrides,
  };
}

describe("MobileCashflowList：冲销入口可见性（L1707）", () => {
  it("已入账且未被冲销的流水显示冲销按钮", () => {
    const { container } = renderLight(<MobileCashflowList rows={[makeRow()]} onReverse={() => undefined} />, { user: "admin" });
    expect(within(container).getByText("冲销")).toBeInTheDocument();
  });

  it("已被冲销的流水（存在 reversal_of_id 指向它的冲销流水）不再显示冲销按钮", () => {
    const original = makeRow();
    const reversal: Cashflow = { ...makeRow(), id: 2, flow_no: "CF-002", category: "REVERSAL", reversal_of_id: original.id };
    const { container } = renderLight(<MobileCashflowList rows={[original, reversal]} onReverse={() => undefined} />, { user: "admin" });
    expect(within(container).queryByText("冲销")).toBeNull();
  });

  it("自身带关联单 ID 的流水不显示冲销按钮", () => {
    const { container } = renderLight(<MobileCashflowList rows={[makeRow({ order_id: 9 })]} onReverse={() => undefined} />, { user: "admin" });
    expect(within(container).queryByText("冲销")).toBeNull();
  });
});
