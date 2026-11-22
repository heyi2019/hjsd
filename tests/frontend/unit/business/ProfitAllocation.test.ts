import { describe, expect, it } from "vitest";
import { buildActionAllocationCandidates, buildActionAllocationRows, buildAllocationOptionGroups } from "@/business/profit_allocation/allocationHelpers";

describe("分润配置纯逻辑", () => {
  it("台账给买号新增执行人时，已存分润联动均分（1 人 → 2 人）", () => {
    // 存量：买号只有 1 人，比例 100、金额 30。
    const rows = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "100", allocation_amount: "30" },
      { allocation_type: "SELL", user_id: 4, role: "SALES", allocation_rate: "20", allocation_amount: "6" },
      { allocation_type: "OPERATION", user_id: 5, role: "SERVICE", allocation_rate: "30", allocation_amount: "9" },
      { allocation_type: "COMPANY", user_id: null, role: "OWNER", allocation_rate: "50", allocation_amount: "15" },
    ], { BUY: [1, 2], SELL: [4], OPERATION: [5], COMPANY: [] }, {
      BUY: { allocation_rate: "100.00", allocation_amount: "30.00" },
      SELL: { allocation_rate: "20.00", allocation_amount: "6.00" },
      OPERATION: { allocation_rate: "30.00", allocation_amount: "9.00" },
      COMPANY: { allocation_rate: "50.00", allocation_amount: "15.00" },
    });

    const buyRows = rows.filter((row) => row.allocation_type === "BUY");
    // 新增的执行人直接进入同一行的多选框，比例/金额保持动作合计。
    expect(buyRows).toEqual([expect.objectContaining({ employee_ids: [1, 2], allocation_rate: "100.00", allocation_amount: "30.00" })]);
    const sellRows = rows.filter((row) => row.allocation_type === "SELL");
    expect(sellRows).toEqual([expect.objectContaining({ employee_ids: [4], allocation_rate: "20.00", allocation_amount: "6.00" })]);
    expect(rows.filter((row) => row.allocation_type === "COMPANY")).toHaveLength(1);
  });

  it("台账新增执行人后保留动作合计，均分由后端处理", () => {
    // 只填金额的单（比例留空），台账给买号新增到 3 人；前端只保留合计和人员。
    const rows = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "", allocation_amount: "30" },
      { allocation_type: "SELL", user_id: 4, role: "SALES", allocation_rate: "", allocation_amount: "0" },
      { allocation_type: "OPERATION", user_id: 5, role: "SERVICE", allocation_rate: "", allocation_amount: "0" },
      { allocation_type: "COMPANY", user_id: null, role: "OWNER", allocation_rate: "", allocation_amount: "0" },
    ], { BUY: [1, 2, 3], SELL: [4], OPERATION: [5], COMPANY: [] }, {
      BUY: { allocation_rate: "0.00", allocation_amount: "30.00" },
      SELL: { allocation_rate: "0.00", allocation_amount: "0.00" },
      OPERATION: { allocation_rate: "0.00", allocation_amount: "0.00" },
      COMPANY: { allocation_rate: "0.00", allocation_amount: "0.00" },
    });
    expect(rows.filter((row) => row.allocation_type === "BUY")).toEqual([
      expect.objectContaining({ employee_ids: [1, 2, 3], allocation_rate: "0.00", allocation_amount: "30.00" }),
    ]);
  });

  it("台账执行人与存量一致时合并为一行；台账换人后份额并入合计，候选为空时保留存量人员", () => {
    const same = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "60", allocation_amount: "18" },
      { allocation_type: "BUY", user_id: 2, role: "BUYER", allocation_rate: "40", allocation_amount: "12" },
      { allocation_type: "SELL", user_id: 4, role: "SALES", allocation_rate: "0", allocation_amount: "0" },
      { allocation_type: "OPERATION", user_id: 5, role: "SERVICE", allocation_rate: "0", allocation_amount: "0" },
      { allocation_type: "COMPANY", user_id: null, role: "OWNER", allocation_rate: "0", allocation_amount: "0" },
    ], { BUY: [1, 2], SELL: [4], OPERATION: [5], COMPANY: [] }, {
      BUY: { allocation_rate: "100.00", allocation_amount: "30.00" },
      SELL: { allocation_rate: "0.00", allocation_amount: "0.00" },
      OPERATION: { allocation_rate: "0.00", allocation_amount: "0.00" },
      COMPANY: { allocation_rate: "0.00", allocation_amount: "0.00" },
    });
    expect(same.filter((row) => row.allocation_type === "BUY")).toEqual([
      expect.objectContaining({ employee_ids: [1, 2], allocation_rate: "100.00", allocation_amount: "30.00" }),
    ]);

    // 台账把买号从 1 换成 3：1 已不是该动作执行人（后端会拒绝非执行人收益人），
    // 份额并入合计后只留 3 一行；金额合计仍是 30，不凭空增删钱。
    const replaced = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "100", allocation_amount: "30" },
      { allocation_type: "SELL", user_id: 4, role: "SALES", allocation_rate: "0", allocation_amount: "0" },
      { allocation_type: "OPERATION", user_id: 5, role: "SERVICE", allocation_rate: "0", allocation_amount: "0" },
      { allocation_type: "COMPANY", user_id: null, role: "OWNER", allocation_rate: "0", allocation_amount: "0" },
    ], { BUY: [3], SELL: [4], OPERATION: [5], COMPANY: [] }, {
      BUY: { allocation_rate: "100.00", allocation_amount: "30.00" },
      SELL: { allocation_rate: "0.00", allocation_amount: "0.00" },
      OPERATION: { allocation_rate: "0.00", allocation_amount: "0.00" },
      COMPANY: { allocation_rate: "0.00", allocation_amount: "0.00" },
    });
    expect(replaced.filter((row) => row.allocation_type === "BUY")).toEqual([
      expect.objectContaining({ employee_ids: [3], allocation_rate: "100.00", allocation_amount: "30.00" }),
    ]);

    // 台账没登记该动作执行人时（候选为空）不联动，存量原样回显。
    const noCandidate = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "100", allocation_amount: "30" },
    ], { BUY: [], SELL: [], OPERATION: [], COMPANY: [] }, {
      BUY: { allocation_rate: "100.00", allocation_amount: "30.00" },
    });
    expect(noCandidate.filter((row) => row.allocation_type === "BUY")).toEqual([
      expect.objectContaining({ employee_ids: [1], allocation_amount: "30.00" }),
    ]);
  });
  it("P1/FE-035：分润按建单、卖出和运营信息负责人自动绑定", () => {
    const candidates = buildActionAllocationCandidates({
      form_extra: {
        business_responsible_ids: [11],
        delivery_responsible_ids: [99],
        sell_delivery_responsible_ids: [22],
      },
      events: [
        { id: 1, event_no: "EV-1", order_id: 10, event_type: "BUY", amount: "100", occurred_on: "2026-10-01", is_posted: true, operator_user_ids: [], cancellable_amount: "100" },
        { id: 2, event_no: "EV-2", order_id: 10, event_type: "SELL", amount: "200", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [], cancellable_amount: "200" },
        { id: 3, event_no: "EV-3", order_id: 10, event_type: "OPERATE", operation_type: "DESCRIPTION", amount: "20", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [33], cancellable_amount: "20" },
      ],
    });
    const rows = buildActionAllocationRows([], candidates);

    expect(candidates).toMatchObject({ BUY: [11], SELL: [22], OPERATION: [33], COMPANY: [] });
    expect(rows.map((row) => row.employee_ids ?? row.employee)).toEqual([[11], [22], [33], "COMPANY"]);
    expect(rows.map((row) => row.allocation_type)).toEqual(["BUY", "SELL", "OPERATION", "COMPANY"]);
  });

  it("分润售出优先使用交付负责人，缺失时才回退售出事件操作人或当前人", () => {
    expect(buildActionAllocationCandidates({
      form_extra: { delivery_responsible_ids: [99], sell_delivery_responsible_ids: [22] },
      events: [{ id: 1, event_no: "EV-1", order_id: 10, event_type: "SELL", amount: "200", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [44], cancellable_amount: "200" }],
    })).toMatchObject({ SELL: [22] });
    expect(buildActionAllocationCandidates({
      form_extra: {},
      events: [{ id: 1, event_no: "EV-1", order_id: 10, event_type: "SELL", amount: "200", occurred_on: "2026-10-02", is_posted: true, operator_user_ids: [44], cancellable_amount: "200" }],
    })).toMatchObject({ SELL: [44] });
    expect(buildActionAllocationCandidates({ form_extra: {}, events: [] }, 55)).toMatchObject({ SELL: [55] });
  });

  it("分润候选按动作预分组并保留员工原顺序和禁用状态", () => {
    let reads = 0;
    const options = Array.from({ length: 200 }, (_, index) => ({
      get value() { reads += 1; return index + 1; }, label: `员工${index + 1}`, disabled: index === 1,
    }));
    const company = { value: "COMPANY" as const, label: "公司", disabled: false };
    const groups = buildAllocationOptionGroups({ BUY: [1, 2], SELL: [2, 3], OPERATION: [], COMPANY: [] }, [...options, company]);
    expect(groups.BUY.map((item) => item.label)).toEqual(["员工1", "员工2"]);
    expect(groups.BUY[1].disabled).toBe(true);
    expect(groups.SELL.map((item) => item.label)).toEqual(["员工2", "员工3"]);
    expect(groups.other).toHaveLength(200);
    expect(reads).toBeLessThanOrEqual(400);
  });
});
