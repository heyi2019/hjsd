import { describe, expect, it } from "vitest";
import { orderOperationMenuItems } from "@/orders/operations";

describe("订单运营菜单", () => {
  it("不可用动作直接隐藏，不返回置灰占位", () => {
    const items = orderOperationMenuItems(
      { row: { status: "SOLD", inventory_type: "RECOVERY" } },
      { allowProfileAfterSold: true },
    );

    expect(items.map((item) => item.key)).toEqual(["description", "images"]);
    expect(items.every((item) => !("disabled" in item))).toBe(true);
  });
});
