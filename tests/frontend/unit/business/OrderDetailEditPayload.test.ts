import { describe, expect, it } from "vitest";
import { buildEventEdits } from "@/orders/OrderDetailView/editing/execution-edit-payload";
import { propagateSharedOrderExtra } from "@/orders/OrderDetailView/editing/use-account-execution-editor";
import { resolveExecutionPlatform } from "@/orders/OrderDetailView/OrderDetail.shared";

describe("详情编辑保存载荷", () => {
  it("会提交事件的文本、时间和操作人修改", () => {
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
        1: { order_id: 1, occurred_at: "", operator: "", note: "", form_extra: { delivery_note: "保留" } },
      },
      [1, 2],
      { bound_phone_owner: "新绑定人" },
    );

    expect(result[1].form_extra).toEqual({ delivery_note: "保留", bound_phone_owner: "新绑定人" });
    expect(result[2].form_extra).toEqual({ bound_phone_owner: "新绑定人" });
  });
});
