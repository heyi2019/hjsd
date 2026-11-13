import { buildActionAllocationCandidates, buildActionAllocationRows } from "@/orders/orderpage/helpers";
import { describe, expect, it, vi } from "vitest";
import { accountFinancialFlows, INVENTORY_AGE_COLOR, rebateTypeLabel, INVENTORY_TYPE_LABEL } from "@/stocks/inventory-logic";
import { applyOffsetEventSelection } from "@/stocks/InventoryCancellationDialog";

describe("库存纯逻辑", () => {
  it("展示提号库存类型", () => {
    expect(INVENTORY_TYPE_LABEL.PICKUP).toBe("提号");
  });

  // 库龄天数与 7/30 天档位由后端下发（见 tests/v1/test_account_inventory_age.py），
  // 前端只剩「档位 → 颜色」这一层展示映射。
  it("库龄档位映射到标签颜色", () => {
    expect(INVENTORY_AGE_COLOR.NORMAL).toBe("green");
    expect(INVENTORY_AGE_COLOR.WARNING).toBe("orange");
    expect(INVENTORY_AGE_COLOR.OVERDUE).toBe("red");
    expect(Object.keys(INVENTORY_AGE_COLOR)).toHaveLength(3);
  });

  it("返点类型优先使用业务类型", () => {
    expect(rebateTypeLabel("BUY", "卖号返点")).toBe("买号返点");
    expect(rebateTypeLabel(null, "卖号返点")).toBe("卖号返点");
  });

  it("资金明细同时归集动作流水和订单附加流水", () => {
    const detail = {
      orders: [{
        order_no: "HS0001",
        events: [{ event_no: "EV1", cashflow: { flow_no: "CF1" } }],
        cashflows: [{ flow_no: "CF2" }],
      }],
    } as never;
    expect(accountFinancialFlows(detail)).toHaveLength(2);
  });
  // —— P0/P1 Round 2026-11-01 回归桶归并（原 P0P1Round20261101.test.tsx）——

  it("P1/FE-035：分润按建单、卖出和运营信息负责人自动绑定", () => {
    const candidates = buildActionAllocationCandidates({
      form_extra: {
        business_responsible_ids: [11],
        delivery_responsible_ids: [22],
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

  // —— #19 切换冲销流水的字段回填（金额 / 资金池 / 操作人重置）——
  it("切换冲销流水：金额与资金池跟随新流水，操作人重置为默认值", () => {
    const setFieldValue = vi.fn();
    applyOffsetEventSelection(
      setFieldValue,
      { remaining: "320.00", pool_id: 8 },
      [42],
    );
    expect(setFieldValue).toHaveBeenCalledWith("amount", "320.00");
    expect(setFieldValue).toHaveBeenCalledWith("pool_id", 8);
    expect(setFieldValue).toHaveBeenCalledWith("operator_user_ids", [42]);
  });

  it("切换到的新流水无资金池时清空旧账户，不留残留", () => {
    const setFieldValue = vi.fn();
    applyOffsetEventSelection(setFieldValue, { remaining: "50.00" }, [7]);
    // pool_id 必须被显式清空（undefined），否则会残留上一笔流水的账户。
    expect(setFieldValue).toHaveBeenCalledWith("pool_id", undefined);
    expect(setFieldValue).toHaveBeenCalledWith("operator_user_ids", [7]);
  });

  it("未提供默认操作人时清空，交给写路径兜底按当前会话解析", () => {
    const setFieldValue = vi.fn();
    applyOffsetEventSelection(setFieldValue, { remaining: "10.00", pool_id: 3 });
    expect(setFieldValue).toHaveBeenCalledWith("operator_user_ids", undefined);
  });

  it("目标缺失时不改任何字段", () => {
    const setFieldValue = vi.fn();
    applyOffsetEventSelection(setFieldValue, undefined, [1]);
    expect(setFieldValue).not.toHaveBeenCalled();
  });
});
