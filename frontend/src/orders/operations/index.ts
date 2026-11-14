import { consignmentOperation, CONSIGNMENT_OPERATION } from "./consignment";
import { descriptionOperation, DESCRIPTION_OPERATION } from "./description";
import { imagesOperation, IMAGES_OPERATION } from "./images";
import { offsaleOperation, OFFSALE_OPERATION } from "./offsale";
import type { OrderOperationContext, OrderOperationItem } from "./types";

const OPERATION_BUILDERS = [
  consignmentOperation,
  offsaleOperation,
  descriptionOperation,
  imagesOperation,
];

const OPERATION_DEFINITIONS: readonly OrderOperationItem[] = [
  CONSIGNMENT_OPERATION,
  OFFSALE_OPERATION,
  DESCRIPTION_OPERATION,
  IMAGES_OPERATION,
];

export function orderOperationItems(context: OrderOperationContext): OrderOperationItem[] {
  return OPERATION_BUILDERS
    .map((build) => build(context))
    .filter((item): item is OrderOperationItem => item !== null);
}

/** 订单台账固定展示四项运营动作；不可执行项保留在菜单中并置灰。 */
export function orderOperationMenuItems(
  context: OrderOperationContext,
  options: { allowProfileAfterSold?: boolean } = {},
) {
  const activeKeys = new Set(orderOperationItems(context).map((item) => item.key));
  if (options.allowProfileAfterSold && context.row.status === "SOLD") {
    activeKeys.add(DESCRIPTION_OPERATION.key);
    activeKeys.add(IMAGES_OPERATION.key);
  }
  return OPERATION_DEFINITIONS.map((item) => ({
    ...item,
    disabled: !activeKeys.has(item.key),
  }));
}

export { OrderConsignmentModal } from "./consignment";
export { CONSIGNMENT_OPERATION } from "./consignment";
export { OrderPlatformOffsaleModal, consignmentRecords } from "./offsale";
export { OFFSALE_OPERATION } from "./offsale";
export { OrderProfileModal } from "./profile-modal";
export { DESCRIPTION_OPERATION } from "./description";
export { IMAGES_OPERATION } from "./images";
export { unlistAndCancelConsignmentOrders } from "./offsale-service";
export type { ActiveConsignment } from "./offsale";
export type { OrderProfileTarget } from "./profile-modal";
export type { OrderOperationContext, OrderOperationItem, OrderOperationKey } from "./types";
