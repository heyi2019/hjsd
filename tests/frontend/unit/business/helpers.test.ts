import { describe, expect, it } from "vitest";
import dayjs from "dayjs";
import type { Order } from "@/shared/api/catalog";
import {
  buildActionAllocationRows,
  buildOrderPatchPayload,
  buildRefundEventPayload,
  filterBusinessOrders,
  formatOrderAmount,
  pickCancelableEvent,
  resolveCancelAmount,
  validateAllocations,
} from "@/orders/orderpage/helpers";

const order = (overrides: Partial<Order> = {}): Order => ({
  id: 1,
  order_no: "HS-2026-0001",
  order_type: "HS",
  trade_date: "2026-10-01",
  status: "ACTIVE",
  business_mode: "SELF",
  event_total: "1234.00",
  ...overrides,
});

describe("OrdersPage helpers", () => {
  it("按业务类型、模式、游戏和库存状态筛选订单", () => {
    expect(filterBusinessOrders([
      order({ account_game_type: "原神", account_status: "WAITING" }),
      order({ id: 2, order_no: "DG-2026-0002", order_type: "DG", business_mode: "DISTRIBUTION" }),
    ], "HS", "SELF", "原神", "原神", "WAITING")).toHaveLength(1);
  });

  it("格式化订单金额并保留分期口径", () => {
    expect(formatOrderAmount(order())).toBe("¥1,234.00");
    expect(formatOrderAmount(order({ installment_principal: "12000.00", installment_paid: "3000.00", installment_periods: 6 }))).toContain("¥3000.00/12000.00");
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

  it("按操作分润时运营人员和运营份额可以留空", () => {
    const result = validateAllocations([
      { allocation_type: "BUY", employee: 1, role: "BUYER", allocation_rate: "25" },
      { allocation_type: "SELL", employee: 2, role: "SALES", allocation_rate: "25" },
      { allocation_type: "OPERATION", role: "SERVICE", allocation_rate: "", allocation_amount: "" },
      { allocation_type: "COMPANY", employee: "COMPANY", role: "OWNER", allocation_rate: "50" },
    ], "1000.00", "ACTION");

    expect(result).toEqual({
      ok: true,
      items: [
        { user_id: 1, role: "BUYER", allocation_type: "BUY", allocation_rate: "25", allocation_amount: "0" },
        { user_id: 2, role: "SALES", allocation_type: "SELL", allocation_rate: "25", allocation_amount: "0" },
        { user_id: null, role: "SERVICE", allocation_type: "OPERATION", allocation_rate: "0", allocation_amount: "0" },
        { user_id: null, role: "OWNER", allocation_type: "COMPANY", allocation_rate: "50", allocation_amount: "0" },
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

describe("OrdersPage 资金与编辑 payload", () => {
  const remaining = "500.00";

  it("冲销金额留空时取后端剩余可冲金额", () => {
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: {}, remaining })).toEqual({ ok: true, amount: "500.00" });
    expect(resolveCancelAmount({ scope: "INVREFUND", values: { refund_amount: "" }, remaining })).toEqual({ ok: true, amount: "500.00" });
  });

  it("部分冲销按填写值提交，超过剩余金额则拒绝", () => {
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: { cancel_amount: "300" }, remaining }))
      .toEqual({ ok: true, amount: "300" });
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: { cancel_amount: "500.01" }, remaining }))
      .toEqual({ ok: false, error: "冲销金额不能超过该动作剩余可冲金额 ¥500.00" });
  });

  it("冲销金额边界与无效值遵守资金安全口径", () => {
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: { cancel_amount: "500.00" }, remaining }))
      .toEqual({ ok: true, amount: "500.00" });
    for (const bad of ["abc", "0", "-1", " "]) {
      const result = resolveCancelAmount({ scope: "ORDERCANC", values: { cancel_amount: bad }, remaining });
      if (bad === " ") expect(result).toEqual({ ok: true, amount: "500.00" });
      else expect(result).toEqual({ ok: false, error: "请输入有效的冲销金额" });
    }
  });

  it("两种冲销 scope 读取各自的金额字段", () => {
    expect(resolveCancelAmount({ scope: "INVREFUND", values: { refund_amount: "120", cancel_amount: "999" }, remaining }))
      .toEqual({ ok: true, amount: "120" });
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: { refund_amount: "999", cancel_amount: "120" }, remaining }))
      .toEqual({ ok: true, amount: "120" });
  });

  it("选择冲销流水时优先显式选择，否则取第一条", () => {
    const list = [
      { event: { id: 102 }, remaining: "500.00" },
      { event: { id: 101 }, remaining: "1000.00" },
    ];
    expect(pickCancelableEvent(list, 101)?.event.id).toBe(101);
    expect(pickCancelableEvent(list, undefined)?.event.id).toBe(102);
    expect(pickCancelableEvent(list, "101")?.event.id).toBe(101);
    expect(pickCancelableEvent(list, 999)?.event.id).toBe(102);
    expect(pickCancelableEvent([], 101)).toBeUndefined();
  });

  const snapshot = {
    game_account: "acc-1",
    game_type: "原神",
    game_password: "pwd-1",
    channel_region: "天空岛",
    bound_phone: "test-phone-0000",
    wallet_realname: "何一",
    camp_account: "camp-1",
    platform: "安卓",
    purchase_price: "800.00",
    note: "建单备注",
  };

  it("编辑订单 payload 保留成交日期、备注和账号快照", () => {
    const payload = buildOrderPatchPayload({
      values: { trade_date: "2026-11-02", note: " 改备注 ", snap_game_type: "星穹铁道" },
      snapshot,
    });
    expect(payload).toMatchObject({
      trade_date: "2026-11-02",
      note: "改备注",
      account_snapshot: { game_account: "acc-1", game_type: "星穹铁道" },
    });
  });

  it("账号密码被隐去时不提交空快照，缺失控件沿用原值", () => {
    expect(buildOrderPatchPayload({ values: { note: "x", snap_game_account: "acc-9" }, snapshot: { ...snapshot, game_password: null } }).account_snapshot)
      .toBeUndefined();
    expect(buildOrderPatchPayload({ values: { note: "x", snap_game_type: "原神", snap_game_password: "pwd-1" }, snapshot }).account_snapshot)
      .toMatchObject({ wallet_realname: "何一", camp_account: "camp-1" });
  });

  it("编辑备注留空时显式提交 null", () => {
    expect(buildOrderPatchPayload({ values: { note: "   " }, snapshot: null }).note).toBeNull();
  });

  it("退款 payload 补齐日期并正确处理资金账户", () => {
    const fallbackDate = "2026-11-03";
    expect(buildRefundEventPayload({ values: { amount: "88.00", occurred_on: null, pool_id: 3, reason: "退款" }, fallbackDate }).occurred_on)
      .toBe(fallbackDate);
    expect(buildRefundEventPayload({ values: { amount: "88.00", occurred_on: dayjs("2026-10-20"), pool_id: 3, reason: "退款" }, fallbackDate }))
      .toMatchObject({ event_type: "REFUND", amount: "88.00", occurred_on: "2026-10-20", pool_id: 3 });
    expect(buildRefundEventPayload({ values: { amount: "1", reason: "x" }, fallbackDate }).pool_id).toBeUndefined();
    expect(buildRefundEventPayload({ values: { amount: "1", reason: "x", pool_id: "" as never }, fallbackDate }).pool_id).toBeUndefined();
    expect(buildRefundEventPayload({ values: { amount: "1", reason: "x", pool_id: "7" }, fallbackDate }).pool_id).toBe(7);
  });
});

describe("validateAllocations 边界", () => {
  it("纯比例合计 100% 时归一化 item", () => {
    expect(validateAllocations([{ employee: 9, allocation_rate: "100", allocation_amount: "0" }], "5000.00")).toEqual({
      ok: true,
      items: [{ user_id: 9, role: "OWNER", allocation_rate: "100", allocation_amount: "0" }],
    });
  });

  it("按金额分润时比例归零并保留金额", () => {
    expect(validateAllocations([{ employee: 9, allocation_rate: "0", allocation_amount: "200" }], "5000.00")).toEqual({
      ok: true,
      items: [{ user_id: 9, role: "OWNER", allocation_rate: "0", allocation_amount: "200" }],
    });
  });

  it("透传非默认角色", () => {
    const result = validateAllocations([{ employee: 9, role: "OPERATION", allocation_rate: "100" }], "5000.00");
    expect(result.ok && result.items[0].role).toBe("OPERATION");
  });

  it("纯比例合计非 100% 时拒绝", () => {
    expect(validateAllocations([{ employee: 9, allocation_rate: "50", allocation_amount: "0" }], "5000.00"))
      .toEqual({ ok: false, error: "按比例分润时合计必须为 100%（也可改用金额）" });
  });

  it("同一行比例与金额换算不一致时拒绝", () => {
    expect(validateAllocations([{ employee: 9, allocation_rate: "50", allocation_amount: "200" }], "5000.00"))
      .toEqual({ ok: false, error: "比例和金额换算不一致" });
  });

  it("同一行比例与金额换算一致时按金额通过", () => {
    const result = validateAllocations([{ employee: 9, allocation_rate: "50", allocation_amount: "2500" }], "5000.00");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]).toMatchObject({ allocation_rate: "0", allocation_amount: "2500" });
  });

  it("亏损单金额方向必须为负数", () => {
    expect(validateAllocations([{ employee: 9, allocation_rate: "0", allocation_amount: "200" }], "-800.00"))
      .toEqual({ ok: false, error: "该单为亏损单，分润金额必须填负数（亏损分担额）" });
    const result = validateAllocations([{ employee: 9, allocation_rate: "0", allocation_amount: "-200" }], "-800.00");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]).toMatchObject({ allocation_rate: "0", allocation_amount: "-200" });
  });

  it("亏损单超额分担时拒绝", () => {
    const result = validateAllocations([{ employee: 9, allocation_rate: "0", allocation_amount: "-900" }], "-800.00");
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("分润金额合计不能超过订单总利润");
  });

  it("盈利单不能填负数金额", () => {
    expect(validateAllocations([{ employee: 9, allocation_rate: "0", allocation_amount: "-200" }], "500.00"))
      .toEqual({ ok: false, error: "该单为盈利单，分润金额不能为负数" });
  });

  it("利润为 0 时按比例分润仍可通过", () => {
    expect(validateAllocations([{ employee: 9, allocation_rate: "100", allocation_amount: "0" }], "0.00").ok).toBe(true);
  });

  it("金额合计超过订单总利润时拒绝", () => {
    const result = validateAllocations([{ employee: 9, allocation_rate: "0", allocation_amount: "800" }], "500.00");
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("分润金额合计不能超过订单总利润");
  });

  it("某行比例与金额均为空时拒绝", () => {
    expect(validateAllocations([{ employee: 9, allocation_rate: "0", allocation_amount: "0" }], "5000.00"))
      .toEqual({ ok: false, error: "每行至少填比例或金额之一" });
  });
});
