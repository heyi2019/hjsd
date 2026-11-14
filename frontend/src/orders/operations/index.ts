import { consignmentOperation, CONSIGNMENT_OPERATION } from "./consignment";
import { descriptionOperation, DESCRIPTION_OPERATION } from "./description";
import { imagesOperation, IMAGES_OPERATION } from "./images";
import { offsaleOperation, OFFSALE_OPERATION } from "./offsale";
import type { InventoryOperationContext, InventoryOperationItem } from "./types";

const OPERATION_BUILDERS = [
  consignmentOperation,
  offsaleOperation,
  descriptionOperation,
  imagesOperation,
];

const OPERATION_DEFINITIONS: readonly InventoryOperationItem[] = [
  CONSIGNMENT_OPERATION,
  OFFSALE_OPERATION,
  DESCRIPTION_OPERATION,
  IMAGES_OPERATION,
];

export function inventoryOperationItems(context: InventoryOperationContext): InventoryOperationItem[] {
  return OPERATION_BUILDERS
    .map((build) => build(context))
    .filter((item): item is InventoryOperationItem => item !== null);
}

/** 订单台账固定展示四项运营动作；不可执行项保留在菜单中并置灰。 */
export function inventoryOperationMenuItems(
  context: InventoryOperationContext,
  options: { allowProfileAfterSold?: boolean } = {},
) {
  const activeKeys = new Set(inventoryOperationItems(context).map((item) => item.key));
  if (options.allowProfileAfterSold && context.row.status === "SOLD") {
    activeKeys.add(DESCRIPTION_OPERATION.key);
    activeKeys.add(IMAGES_OPERATION.key);
  }
  return OPERATION_DEFINITIONS.map((item) => ({
    ...item,
    disabled: !activeKeys.has(item.key),
  }));
}

export { InventoryConsignmentModal } from "./consignment";
export { CONSIGNMENT_OPERATION } from "./consignment";
export { InventoryPlatformOffsaleModal, consignmentRecords } from "./offsale";
export { OFFSALE_OPERATION } from "./offsale";
export { InventoryProfileModal } from "./profile-modal";
export { DESCRIPTION_OPERATION } from "./description";
export { IMAGES_OPERATION } from "./images";
export { unlistAndCancelConsignmentOrders } from "./offsale-service";
export type { ActiveConsignment } from "./offsale";
export type { InventoryProfileTarget } from "./profile-modal";
export type { InventoryOperationContext, InventoryOperationItem, InventoryOperationKey } from "./types";
