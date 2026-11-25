// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildEventEdits, buildFinanceEdits, buildOrderEdits } from "@/business/shared/order_detail/editing/execution-edit-payload";
import { propagateSharedOrderExtra, sharedOrderIdsForEdit } from "@/business/shared/order_detail/editing/editor-utils";
import { resolveExecutionPlatform } from "@/business/shared/order_detail/OrderDetail.shared";
import { mergeLedgerOrderWithDetail } from "@/business/orders/useLedgerInlineEdit";
import { buildFinanceSelectOptions } from "@/business/shared/order_detail/finance-options";

describe("详情编辑保存载荷", () => {
  it("资金明细选项保持停用当前账户的位置并复用相同账户候选", () => {
    let reads = 0;
    const pools = [
      { id: 1, name: "经营", get status() { reads += 1; return "ACTIVE"; } },
      { id: 2, name: "停用账户", get status() { reads += 1; return "INACTIVE"; } },
      { id: 3, name: "备用", get status() { reads += 1; return "ACTIVE"; } },
    ];
    const employees = [{ id: 7, display_name: "员工甲", is_active: true }, { id: 8, display_name: "离职员工", is_active: false }];
    const options = buildFinanceSelectOptions(employees, pools);
    expect(options.employees).toEqual([{ value: 7, label: "员工甲", disabled: false }, { value: 8, label: "离职员工", disabled: true }]);
    expect(options.poolsFor(2)).toEqual([{ value: 1, label: "经营", disabled: false }, { value: 2, label: "停用账户", disabled: true }, { value: 3, label: "备用", disabled: false }]);
    expect(options.poolsFor(99)).toEqual([{ value: 1, label: "经营", disabled: false }, { value: 3, label: "备用", disabled: false }]);
    for (let i = 0; i < 50; i += 1) options.poolsFor(2);
    expect(reads).toBeLessThanOrEqual(6);
    const duplicates = buildFinanceSelectOptions([], [
      { id: 2, name: "停用一", status: "INACTIVE" },
      { id: 3, name: "经营", status: "ACTIVE" },
      { id: 2, name: "停用二", status: "INACTIVE" },
    ]);
    expect(duplicates.poolsFor(2).map((item) => item.label)).toEqual(["停用一", "经营", "停用二"]);
  });
  it("批量资金明细按草稿顺序匹配，保持首条同号记录和修改字段", () => {
    let reads = 0;
    const rows = Array.from({ length: 200 }, (_, index) => ({
      get flow_no() { reads += 1; return `CF${index + 1}`; },
      amount: "100", pool_id: 1, occurred_at: "", note: "原备注", operator_user_ids: [1],
    }));
    const drafts = Object.fromEntries(rows.map((_, index) => [`draft${index}`, {
      flow_no: `CF${200 - index}`, amount: "120", pool_id: 2, occurred_at: "2026-11-01T10:00", note: "新备注", operator_user_ids: [2],
    }]));
    const result = buildFinanceEdits(rows, drafts);
    expect(result).toHaveLength(200);
    expect(result?.[0]).toEqual({ flow_no: "CF200", amount: "120", pool_id: 2, occurred_at: "2026-11-01T10:00", note: "新备注", operator_user_ids: [2] });
    expect(result?.[199].flow_no).toBe("CF1");
    expect(reads).toBeLessThanOrEqual(400);
  });

  it("资金明细未修改或无原记录时不提交，同号记录以首条为准", () => {
    const rows = [
      { flow_no: "CF1", amount: "100", pool_id: 1, occurred_at: null, note: "", operator_user_ids: [1] },
      { flow_no: "CF1", amount: "200", pool_id: 2, occurred_at: null, note: "", operator_user_ids: [2] },
    ];
    expect(buildFinanceEdits(rows, {
      first: { flow_no: "CF1", amount: "100", pool_id: 1, occurred_at: "", note: "", operator_user_ids: [1] },
      missing: { flow_no: "missing", amount: "50", occurred_at: "", note: "" },
    })).toEqual([]);
  });

  it.each([
    [{ amount: "120" }, { flow_no: "CF1", amount: "120", note: "原备注" }],
    [{ pool_id: 2 }, { flow_no: "CF1", pool_id: 2, note: "原备注" }],
    [{ occurred_at: "2026-11-01T10:00" }, { flow_no: "CF1", occurred_at: "2026-11-01T10:00", note: "原备注" }],
    [{ note: "新备注" }, { flow_no: "CF1", note: "新备注" }],
    [{ operator_user_ids: [2] }, { flow_no: "CF1", note: "原备注", operator_user_ids: [2] }],
  ])("资金明细单项修改时正确生成载荷 %#", (change, expected) => {
    const rows = [{ flow_no: "CF1", amount: "100", pool_id: 1, occurred_at: null, note: "原备注", operator_user_ids: [1] }];
    expect(buildFinanceEdits(rows, { CF1: { flow_no: "CF1", occurred_at: "", note: "原备注", ...change } })).toEqual([expected]);
  });
  it("大量事件编辑只需线性匹配原记录，并保持草稿顺序", () => {
    let reads = 0;
    const events = Array.from({ length: 200 }, (_, index) => ({
      get id() { reads += 1; return index + 1; },
      amount: "100", note: null, occurred_at: "",
    }));
    const drafts = Object.fromEntries(events.map((_, index) => [index + 1, {
      id: 200 - index, expected_amount: "100", amount: "120", note: null, occurred_at: "",
    }]));
    const result = buildEventEdits(events, drafts);
    expect(result).toHaveLength(200);
    expect(result.map((item) => item.id)).toEqual(Array.from({ length: 200 }, (_, index) => 200 - index));
    expect(reads).toBeLessThanOrEqual(400);
  });

  it("重复事件编号使用首条原记录，找不到原记录时跳过", () => {
    const events = [
      { id: 7, amount: "100", note: null, occurred_at: "" },
      { id: 7, amount: "200", note: null, occurred_at: "" },
    ];
    expect(buildEventEdits(events, {
      7: { id: 7, expected_amount: "100", amount: "100", note: null, occurred_at: "" },
      9: { id: 9, expected_amount: "100", amount: "200", note: null, occurred_at: "" },
    })).toEqual([]);
  });
  it("只改事件备注时不提交未修改的时间", () => {
    const time = "2026-09-10T12:00:00";
    expect(buildEventEdits([{ id: 7, amount: "100", note: "旧备注", occurred_at: time }], {
      7: { id: 7, expected_amount: "100", amount: "100", note: "新备注", occurred_at: time },
    })).toEqual([{ id: 7, expected_amount: "100", amount: "100", note: "新备注" }]);
  });

  it("订单编辑对照业务时间而非建档时间", () => {
    const original = [{ order_id: 21, created_at: "2026-11-14T01:00:00", occurred_at: "2026-09-10T01:00:00", note: "旧备注" }];
    expect(buildOrderEdits(original, {
      21: { order_id: 21, occurred_at: "2026-09-10T01:00:00", note: "新备注", form_extra: {} },
    })).toEqual([{ order_id: 21, note: "新备注" }]);
  });
  it("会提交事件和订单实际修改的文本、时间和操作人", () => {
    const payload = buildEventEdits(
      [{ id: 7, amount: "100.00", note: "旧备注", occurred_at: "2026-11-14T01:00:00" }],
      {
        7: {
          id: 7,
          expected_amount: "100.00",
          amount: "100.00",
          note: "新备注",
          occurred_at: "2026-11-14T02:00:00",
          operator_user_ids: [11, 12],
        },
      },
    );

    expect(payload).toEqual([
      {
        id: 7,
        expected_amount: "100.00",
        amount: "100.00",
        note: "新备注",
        occurred_at: "2026-11-14T02:00:00",
        operator_user_ids: [11, 12],
      },
    ]);
    const original = [{ order_id: 21, created_at: "2026-11-14T01:00:00", note: "旧备注" }];
    expect(buildOrderEdits(original, {
      21: { order_id: 21, occurred_at: "2026-11-14T01:00:00", note: "旧备注", form_extra: { sell_bound_phone: "139" } },
    })).toEqual([{ order_id: 21, form_extra: { sell_bound_phone: "139" } }]);
    expect(buildOrderEdits(original, {
      21: { order_id: 21, occurred_at: "2026-11-14T02:00:00", note: "新备注", form_extra: {} },
    })).toEqual([{ order_id: 21, occurred_at: "2026-11-14T02:00:00", note: "新备注" }]);
  });

  it("运营动作修改平台后，操作明细使用同一份事件草稿", () => {
    const event = {
      event_type: "OPERATE",
      operation_type: "CONSIGNMENT" as const,
      form_extra: { consignment_platforms: ["千寻"] },
    };

    expect(resolveExecutionPlatform("千寻", event, {
      form_extra: { consignment_platforms: ["盼之"] },
    })).toBe("盼之");
  });

  it("运营动作清空平台后，执行明细不再回退到旧快照", () => {
    const event = {
      event_type: "OPERATE",
      operation_type: "CONSIGNMENT" as const,
      form_extra: { consignment_platforms: ["千寻"] },
    };

    expect(resolveExecutionPlatform("千寻", event, { form_extra: {} })).toBe("-");
  });

  it("交付共享字段修改后，详情内的相关订单草稿一起更新", () => {
    const result = propagateSharedOrderExtra(
      {
        1: { order_id: 1, occurred_at: "", note: "", form_extra: { delivery_note: "保留" } },
      },
      [1, 2],
      { bound_phone_owner: "新绑定人" },
      [{ order_id: 2, created_at: "2026-11-01T10:00:00", note: "原备注" }],
    );

    expect(result[1].form_extra).toEqual({ delivery_note: "保留", bound_phone_owner: "新绑定人" });
    expect(result[2].form_extra).toEqual({ bound_phone_owner: "新绑定人" });
    expect(result[2]).toMatchObject({ occurred_at: "2026-11-01T10:00:00", note: "原备注" });
  });

  it("批量同步交付字段时线性匹配订单并保留首条同号记录", () => {
    let reads = 0;
    const originals = Array.from({ length: 200 }, (_, index) => ({
      get order_id() { reads += 1; return index + 1; },
      created_at: `time-${index + 1}`, note: `备注-${index + 1}`,
    }));
    originals.push({ order_id: 1, created_at: "duplicate", note: "duplicate" });
    const result = propagateSharedOrderExtra({}, Array.from({ length: 200 }, (_, index) => 200 - index),
      { bound_phone_owner: "甲" }, originals);
    expect(result[1]).toMatchObject({ occurred_at: "time-1", note: "备注-1", form_extra: { bound_phone_owner: "甲" } });
    expect(result[200]).toMatchObject({ occurred_at: "time-200", note: "备注-200" });
    expect(reads).toBeLessThanOrEqual(402);
  });

  it("没有共享字段时保留原草稿，已有草稿优先于原订单", () => {
    const drafts = { 1: { order_id: 1, occurred_at: "draft", note: "草稿", form_extra: {} } };
    expect(propagateSharedOrderExtra(drafts, [1], { unrelated: "x" })).toBe(drafts);
    expect(propagateSharedOrderExtra(drafts, [1, 2], { bound_phone_owner: "甲" }, [
      { order_id: 1, created_at: "original", note: "原订单" },
    ])).toEqual({
      1: { order_id: 1, occurred_at: "draft", note: "草稿", form_extra: { bound_phone_owner: "甲" } },
      2: { order_id: 2, occurred_at: "", note: "", form_extra: { bound_phone_owner: "甲" } },
    });
  });

  it("详情缓存存在时使用全部关联订单，否则只更新当前订单", () => {
    expect(sharedOrderIdsForEdit({ orders: [{ order_id: 3 }, { order_id: 4 }] } as never, 9)).toEqual([3, 4]);
    expect(sharedOrderIdsForEdit(undefined, 9)).toEqual([9]);
  });

  it("订单详情保存后同步更新订单台账主列表字段", () => {
    const order = {
      id: 7,
      account_id: 9,
      account_game_type: "旧类型",
      account_game_account: "旧账号",
      account_status: "WAITING",
      cost_amount: "10.00",
    };
    const detail = {
      account: {
        id: 9,
        game_type: "新类型",
        game_account: "新账号",
        status: "SOLD",
        cost_amount: "20.00",
      },
    };

    expect(mergeLedgerOrderWithDetail(order as never, detail as never)).toMatchObject({
      id: 7,
      account_game_type: "新类型",
      account_game_account: "新账号",
      account_status: "SOLD",
      cost_amount: "20.00",
    });
  });
});
