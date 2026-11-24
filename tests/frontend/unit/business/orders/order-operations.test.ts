import { describe, expect, it } from "vitest";
import { authorizedOrderOperationItems, orderOperationMenuItems } from "@/business/shared/operations";

describe("订单运营菜单", () => {
  it("只具备事件权限时显示上架，需要编辑权限的动作保持隐藏", () => {
    const items = [
      { key: "consignment", label: "上架" }, { key: "offsale", label: "下架" },
      { key: "description", label: "描述" }, { key: "images", label: "作图" },
    ] as const;
    expect(authorizedOrderOperationItems([...items], (permission) => permission === "order.event.post").map((item) => item.key)).toEqual(["consignment"]);
    expect(authorizedOrderOperationItems([...items], () => false)).toEqual([]);
  });
  it("不可用动作直接隐藏，不返回置灰占位", () => {
    const items = orderOperationMenuItems(
      { row: { status: "SOLD", inventory_type: "RECOVERY" } },
      { allowProfileAfterSold: true },
    );

    expect(items.map((item) => item.key)).toEqual(["description", "images"]);
    expect(items.every((item) => !("disabled" in item))).toBe(true);
  });
});
