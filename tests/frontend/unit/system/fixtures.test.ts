import { beforeEach, describe, expect, it } from "vitest";
import { DEV_USER_KEY } from "@/shared/api/client";
import { allFormFields } from "@fixtures/orderFormFieldsSeed";
import { OPTION_SET_SEED } from "@fixtures/optionSetsSeed";
import { customerDetail, customerSummary, dashboardSummary, dataCenterSummary, installmentTotals, inventoryLedgerResponse, listResponse, orderLedgerSummary, pageResponse, poolBalancesResponse, profitAllocationResponse, reportResponse, commissionResponse, cashflowPage, cashflowTotals, studioExpenseSummary } from "@fixtures/api-responses";
import { resetTestFixtureState } from "@fixtures/fixtures";

describe("测试夹具隔离", () => {
  beforeEach(() => {
    resetTestFixtureState();
  });

  it("清理角色、会话和页面级主题状态", () => {
    localStorage.setItem(DEV_USER_KEY, "admin");
    sessionStorage.setItem("fixture-session", "stale");
    document.documentElement.dataset.theme = "dark";

    resetTestFixtureState();

    expect(localStorage.getItem(DEV_USER_KEY)).toBeNull();
    expect(sessionStorage.getItem("fixture-session")).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("表单字段种子重复读取时保持稳定且编号唯一", () => {
    const first = allFormFields();
    const second = allFormFields();

    expect(second).toEqual(first);
    expect(new Set(first.map((field) => field.id)).size).toBe(first.length);
  });

  it("选项词典种子编码唯一且每个选项值唯一", () => {
    expect(new Set(OPTION_SET_SEED.map((set) => set.code)).size).toBe(OPTION_SET_SEED.length);
    OPTION_SET_SEED.forEach((set) => {
      expect(new Set(set.options.map((option) => option.value)).size).toBe(set.options.length);
    });
  });

  it("提供符合接口契约的分页、台账汇总和流水汇总响应", () => {
    expect(pageResponse([{ id: 1 }], { total: 3, limit: 1, offset: 2 })).toEqual({
      items: [{ id: 1 }],
      total: 3,
      limit: 1,
      offset: 2,
    });
    expect(orderLedgerSummary({ total_count: 2 })).toEqual({
      total_count: 2,
      status_counts: {},
      type_counts: {},
      game_types: [],
    });
    expect(cashflowTotals({ total_in: "12.00" })).toEqual({ total_in: "12.00", total_out: "0.00" });
    expect(cashflowPage([{ id: 1 }], { total_in: "12.00", total_out: "3.00" })).toEqual({
      items: [{ id: 1 }],
      total: 1,
      total_in: "12.00",
      total_out: "3.00",
    });
    expect(reportResponse([{ month: "2026-11" }], { income: "1.00" })).toEqual({
      items: [{ month: "2026-11" }],
      total: { income: "1.00" },
    });
    expect(commissionResponse([{ order_id: 1 }], { order_count: 1, profit_base: "10.00" })).toEqual({
      order_groups: [{ order_id: 1 }],
      total: { order_count: 1, profit_base: "10.00" },
    });
    expect(dataCenterSummary({ order_count: 2, profit: "80.00" })).toEqual({
      order_count: 2,
      active_order_count: 0,
      sold_cost: "0.00",
      in_transit_cost: "0.00",
      deposit_held: "0.00",
      studio_cost: "0.00",
      account_sale_profit: "0.00",
      studio_other_income: "0.00",
      profit: "80.00",
    });
    expect(listResponse([{ id: 1 }])).toEqual({ items: [{ id: 1 }], total: 1 });
    expect(listResponse([{ id: 1 }], 3)).toEqual({ items: [{ id: 1 }], total: 3 });
    expect(profitAllocationResponse([{ id: 1 } as never], { order_profit: "10.00" })).toEqual({
      items: [{ id: 1 }],
      total: 1,
      order_profit: "10.00",
      totals_by_type: {},
    });
    expect(inventoryLedgerResponse([{ id: 1 } as never])).toEqual({
      items: [{ id: 1 }],
      total: 1,
      facet_total: 1,
      type_counts: {},
      game_types: [],
      stats: { account_count: 0, occupied_cost: "0.00", over_7d_count: 0, over_30d_count: 0 },
    });
    expect(poolBalancesResponse([{ pool_id: 1 } as never], { pool_count: 1, cash_balance: "10.00", available: "8.00", deposit_held: "2.00", owned_cash_balance: "10.00" })).toEqual({
      items: [{ pool_id: 1 }],
      totals: { pool_count: 1, cash_balance: "10.00", available: "8.00", deposit_held: "2.00", owned_cash_balance: "10.00" },
    });
    expect(studioExpenseSummary([{ id: 1 } as never], { income: "3.00", expense: "1.00", net: "2.00" })).toEqual({
      items: [{ id: 1 }],
      income: "3.00",
      expense: "1.00",
      net: "2.00",
      count: 1,
    });
    expect(installmentTotals({ total_paid: "3.00" })).toEqual({
      total_receivable: "0.00",
      total_paid: "3.00",
      total_remaining: "0.00",
      total_count: 0,
      overdue_count: 0,
    });
    expect(dashboardSummary({ personal_orders: 2, personal_earnings: "3.00" })).toEqual({
      period: { from: "2026-11-01", to: "2026-11-16" },
      orders: { total_count: 0, completed_count: 0, active_count: 0 },
      personal_orders: 2,
      personal_earnings: "3.00",
      inventory: { account_count: 0, aging_count: 0, overdue_count: 0 },
      installments: { total_count: 0, overdue_count: 0 },
      notifications: { pending_profit_count: 0, allocated_profit_count: 0 },
      reminders: { inventory_aging_days: 7, profit_notifications_enabled: true, overdue_installments_enabled: true },
    });
    expect(customerSummary({ month_count: 2 })).toEqual({ month_count: 2, today_count: 0 });
    expect(customerDetail({ id: 1, customer_no: "CUS-0001", display_name: "张三", status: "ACTIVE" })).toEqual({
      customer: { id: 1, customer_no: "CUS-0001", display_name: "张三", status: "ACTIVE" },
      overview: {
        order_count: 0,
        active_order_count: 0,
        completed_order_count: 0,
        cancelled_order_count: 0,
        last_trade_date: null,
        installment_paid_total: "0.00",
        installment_receivable_total: "0.00",
        installment_remaining_total: "0.00",
        overdue_period_count: 0,
      },
      business: [],
      installments: [],
      audit: [],
    });
  });
});
