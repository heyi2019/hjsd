import { describe, expect, it } from "vitest";
import type { Order } from "@/shared/api/types/orders";
import {
  allocationAmountFromRate,
  allocationRateFromAmount,
  buildActionAllocationRows,
  filterBusinessOrders,
  formatOrderAmount,
  validateAllocations,
} from "@/orders/orderpage/helpers";

const order = (overrides: Partial<Order> = {}): Order => ({
  id: 1,
  order_no: "HS-2026-0001",
  order_type: "HS",
  capital_type: "SELF",
  trade_date: "2026-10-01",
  status: "ACTIVE",
  business_mode: "SELF",
  event_total: "1234.00",
  ...overrides,
});

describe("OrdersPage helpers", () => {
  it("按订单利润把分润比例换算成金额", () => {
    expect(allocationAmountFromRate("5000.00", "30")).toBe("1500.00");
    expect(allocationAmountFromRate("5000.00", "")).toBe("");
  });

  it("按订单利润把分润金额反算成比例", () => {
    expect(allocationRateFromAmount("5000.00", "1500")).toBe("30.00");
    expect(allocationRateFromAmount("0.00", "1500")).toBe("");
  });

  it("分润比例↔金额走整数分：333.35 × 30% = 100.01，不再少 1 分", () => {
    // 旧实现 (333.35 * 30 / 100).toFixed(2) 因浮点 100.00499... 得 "100.00"。
    expect(allocationAmountFromRate("333.35", "30")).toBe("100.01");
    // 反算同走基点：100.01 / 333.35 → 3000bp → 30.00%。
    expect(allocationRateFromAmount("333.35", "100.01")).toBe("30.00");
    // 亏损单允许负数分润，符号必须保留。
    expect(allocationAmountFromRate("-333.35", "30")).toBe("-100.00");
  });

  it("按业务类型、模式、游戏和库存状态筛选订单", () => {
    expect(filterBusinessOrders([
      order({ account_game_type: "原神", account_status: "WAITING" }),
      order({ id: 2, order_no: "DG-2026-0002", order_type: "DG", business_mode: "DISTRIBUTION" }),
    ], "HS", "SELF", "原神", "原神", "WAITING")).toHaveLength(1);
  });

  it("格式化订单售出金额，不把买入金额混进来", () => {
    expect(formatOrderAmount(order({ event_total: "2500.00", sale_amount: "1500.00" }))).toBe("¥1,500.00");
    expect(formatOrderAmount(order({ event_total: "1000.00", sale_amount: null }))).toBe("-");
  });

  it("校验比例分润并归一化公司归属", () => {
    expect(validateAllocations([{ employee: "COMPANY", allocation_rate: "100" }], "5000.00")).toEqual({
      ok: true,
      items: [{ user_id: null, role: "OWNER", allocation_rate: "100", allocation_amount: "0" }],
    });
  });

  it("按操作分润把同一动作的份额按人数均分（3 人 100% → 33.33/33.33/33.34）", () => {
    // 首行填「买号合计 100%」，后两行是只读的人均行（SHARED）；
    // 其余三项填 0，保证四项合计仍是 100%。
    const result = validateAllocations([
      { allocation_type: "BUY", employee: 1, role: "BUYER", allocation_rate: "100", share_mode: "TOTAL" },
      { allocation_type: "BUY", employee: 2, role: "BUYER", share_mode: "SHARED" },
      { allocation_type: "BUY", employee: 3, role: "BUYER", share_mode: "SHARED" },
      { allocation_type: "SELL", role: "SALES", allocation_rate: "0" },
      { allocation_type: "OPERATION", employee: 4, role: "SERVICE", allocation_rate: "0" },
      { allocation_type: "COMPANY", employee: "COMPANY", role: "OWNER", allocation_rate: "0" },
    ], "5000.00", "ACTION");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const buyRows = result.items.filter((item) => item.allocation_type === "BUY");
    // 100 ÷ 3 除不尽，余数 0.01 给最后一人，合计仍然正好 100。
    expect(buyRows.map((item) => item.allocation_rate)).toEqual(["33.33", "33.33", "33.34"]);
    expect(buyRows.map((item) => item.user_id)).toEqual([1, 2, 3]);
    const total = result.items.reduce((sum, item) => sum + Number(item.allocation_rate), 0);
    expect(total).toBeCloseTo(100, 6);
  });

  it("按操作分润支持直接填金额", () => {
    expect(validateAllocations([
      { allocation_type: "BUY", employee: 1, allocation_rate: "20", allocation_amount: "200" },
      { allocation_type: "SELL", allocation_rate: "10", allocation_amount: "100" },
      { allocation_type: "OPERATION", allocation_rate: "10", allocation_amount: "100" },
      { allocation_type: "COMPANY", employee: "COMPANY", allocation_rate: "50", allocation_amount: "500" },
    ], "1000.00", "ACTION")).toEqual({
      ok: true,
      items: [
        { user_id: 1, role: "BUYER", allocation_type: "BUY", allocation_rate: "0", allocation_amount: "200" },
        { user_id: null, role: "SALES", allocation_type: "SELL", allocation_rate: "0", allocation_amount: "100" },
        { user_id: null, role: "SERVICE", allocation_type: "OPERATION", allocation_rate: "0", allocation_amount: "100" },
        { user_id: null, role: "OWNER", allocation_type: "COMPANY", allocation_rate: "0", allocation_amount: "500" },
      ],
    });
  });

  it("台账给买号新增执行人时，已存分润联动均分（1 人 → 2 人）", () => {
    // 存量：买号只有 1 人，比例 100、金额 30。
    const rows = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "100", allocation_amount: "30" },
      { allocation_type: "SELL", user_id: 4, role: "SALES", allocation_rate: "20", allocation_amount: "6" },
      { allocation_type: "OPERATION", user_id: 5, role: "SERVICE", allocation_rate: "30", allocation_amount: "9" },
      { allocation_type: "COMPANY", user_id: null, role: "OWNER", allocation_rate: "50", allocation_amount: "15" },
    ], { BUY: [1, 2], SELL: [4], OPERATION: [5], COMPANY: [] });

    const buyRows = rows.filter((row) => row.allocation_type === "BUY");
    // 新增的执行人 2 自动多出一行；首行仍是「买号合计」，其余只读人均。
    expect(buyRows.map((row) => row.employee)).toEqual([1, 2]);
    expect(buyRows.map((row) => row.share_mode)).toEqual(["TOTAL", "SHARED"]);
    expect(buyRows[0].allocation_rate).toBe("100");
    expect(buyRows[0].allocation_amount).toBe("30");
    expect(buyRows[1].allocation_rate).toBe("");
    expect(buyRows[1].allocation_amount).toBe("");
    // 人数没变的动作保持逐人原值回显，不折叠。
    const sellRows = rows.filter((row) => row.allocation_type === "SELL");
    expect(sellRows).toEqual([expect.objectContaining({ employee: 4, share_mode: "PER_PERSON", allocation_rate: "20" })]);
    expect(rows.filter((row) => row.allocation_type === "COMPANY")).toHaveLength(1);
  });

  it("台账新增执行人后再次保存，按新的总人数均分且合计不变", () => {
    // 只填金额的单（比例留空），台账给买号新增到 3 人。
    const rows = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "", allocation_amount: "30" },
      { allocation_type: "SELL", user_id: 4, role: "SALES", allocation_rate: "", allocation_amount: "0" },
      { allocation_type: "OPERATION", user_id: 5, role: "SERVICE", allocation_rate: "", allocation_amount: "0" },
      { allocation_type: "COMPANY", user_id: null, role: "OWNER", allocation_rate: "", allocation_amount: "0" },
    ], { BUY: [1, 2, 3], SELL: [4], OPERATION: [5], COMPANY: [] });

    const result = validateAllocations(rows, "30.00", "ACTION");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const buyRows = result.items.filter((item) => item.allocation_type === "BUY");
    expect(buyRows.map((item) => item.user_id)).toEqual([1, 2, 3]);
    // 30 ÷ 3 每人 10，合计仍是 30（不超额、不缺额）。
    expect(buyRows.map((item) => item.allocation_amount)).toEqual(["10", "10", "10"]);
  });

  it("台账执行人与存量一致时不折叠；台账换人后份额并入合计，候选为空时原样回显", () => {
    const same = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "60", allocation_amount: "18" },
      { allocation_type: "BUY", user_id: 2, role: "BUYER", allocation_rate: "40", allocation_amount: "12" },
      { allocation_type: "SELL", user_id: 4, role: "SALES", allocation_rate: "0", allocation_amount: "0" },
      { allocation_type: "OPERATION", user_id: 5, role: "SERVICE", allocation_rate: "0", allocation_amount: "0" },
      { allocation_type: "COMPANY", user_id: null, role: "OWNER", allocation_rate: "0", allocation_amount: "0" },
    ], { BUY: [1, 2], SELL: [4], OPERATION: [5], COMPANY: [] });
    expect(same.filter((row) => row.allocation_type === "BUY")).toEqual([
      expect.objectContaining({ employee: 1, share_mode: "PER_PERSON", allocation_rate: "60" }),
      expect.objectContaining({ employee: 2, share_mode: "PER_PERSON", allocation_rate: "40" }),
    ]);

    // 台账把买号从 1 换成 3：1 已不是该动作执行人（后端会拒绝非执行人收益人），
    // 份额并入合计后只留 3 一行；金额合计仍是 30，不凭空增删钱。
    const replaced = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "100", allocation_amount: "30" },
      { allocation_type: "SELL", user_id: 4, role: "SALES", allocation_rate: "0", allocation_amount: "0" },
      { allocation_type: "OPERATION", user_id: 5, role: "SERVICE", allocation_rate: "0", allocation_amount: "0" },
      { allocation_type: "COMPANY", user_id: null, role: "OWNER", allocation_rate: "0", allocation_amount: "0" },
    ], { BUY: [3], SELL: [4], OPERATION: [5], COMPANY: [] });
    expect(replaced.filter((row) => row.allocation_type === "BUY")).toEqual([
      expect.objectContaining({ employee: 3, share_mode: "TOTAL", allocation_rate: "100", allocation_amount: "30" }),
    ]);

    // 台账没登记该动作执行人时（候选为空）不联动，存量原样回显。
    const noCandidate = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "100", allocation_amount: "30" },
    ], { BUY: [], SELL: [], OPERATION: [], COMPANY: [] });
    expect(noCandidate.filter((row) => row.allocation_type === "BUY")).toEqual([
      expect.objectContaining({ employee: 1, share_mode: "PER_PERSON", allocation_amount: "30" }),
    ]);
  });
});
