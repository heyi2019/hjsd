import { describe, expect, it, vi } from "vitest";
import { INVENTORY_AGE_COLOR, INVENTORY_TYPE_LABEL } from "@/business/shared/inventory/inventory-logic";
import { applyOffsetEventSelection } from "@/business/shared/cancellation/InventoryCancellationDialog";

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


  // —— #19 切换冲销流水的字段回填（金额 / 资金账户 / 操作人重置）——
  it("切换冲销流水：金额与资金账户跟随新流水，操作人重置为默认值", () => {
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

  it("切换到的新流水无资金账户时清空旧账户，不留残留", () => {
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
