/** 状态 / 业务 / 类型的展示文案（用于表格、导出、报表渲染）。
 * ⚠️ 这些是渲染用的静态文案；筛选项的「可选项是哪些」由设置页「选项词典」配置（INVENTORY_STATUS / INVENTORY_BUSINESS / INVENTORY_TYPE）。 */
import { INVENTORY_STATUS_LABEL } from "../shared/lib/labels";

export { INVENTORY_STATUS_LABEL as STATUS_LABEL } from "../shared/lib/labels";

// 业务 / 类型 / 增值服务文案统一引用共享标签源（shared/lib/labels），避免多份副本漂移。
// VALUE_ADDED_SERVICE_LABEL 在此补齐 PICKUP_SALE/CONSIGNMENT_SALE，修复库存页与导出裸码显示。
export { BUSINESS_MODE_LABEL, VALUE_ADDED_SERVICE_LABEL } from "../shared/lib/labels";
export { BUSINESS_TYPE_LABEL as INVENTORY_TYPE_LABEL } from "../shared/lib/labels";

export const EDITABLE_ACCOUNT_TYPES = new Set(["RECOVERY", "PICKUP", "CONSIGNMENT"]);

/** 可编辑/更多操作适用范围：三类业务类型。 */
export function isEditableAccountType(inventoryType?: string | null): boolean {
  return inventoryType == null || EDITABLE_ACCOUNT_TYPES.has(inventoryType);
}

export function inventoryStatusLabel(value: string): string {
  return INVENTORY_STATUS_LABEL[value] ?? value;
}

/** 库龄档位 → 标签色：阈值（7/30 天）与天数都由后端下发，此处只做展示映射。 */
export const INVENTORY_AGE_COLOR: Record<string, "green" | "orange" | "red"> = {
  NORMAL: "green",
  WARNING: "orange",
  OVERDUE: "red",
};
