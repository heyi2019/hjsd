import { describe, expect, it } from "vitest";
import { buildEventEdits, buildOrderEdits } from "@/business/OrderDetailView/editing/execution-edit-payload";
import { propagateSharedOrderExtra, sharedOrderIdsForEdit } from "@/business/OrderDetailView/editing/use-order-detail-editor";
import { resolveExecutionPlatform } from "@/business/OrderDetailView/OrderDetail.shared";
import { mergeLedgerOrderWithDetail } from "@/business/orderpage/useLedgerInlineEdit";

describe("详情编辑保存载荷", () => {
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
