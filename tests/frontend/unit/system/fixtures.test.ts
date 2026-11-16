import { beforeEach, describe, expect, it } from "vitest";
import { DEV_USER_KEY } from "@/shared/api/client";
import { allFormFields } from "@fixtures/orderFormFieldsSeed";
import { OPTION_SET_SEED } from "@fixtures/optionSetsSeed";
import { pageResponse, reportResponse, commissionResponse, orderLedgerSummary, cashflowPage, cashflowTotals } from "@fixtures/api-responses";
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
  });
});
