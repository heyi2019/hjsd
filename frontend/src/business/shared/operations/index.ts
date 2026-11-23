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

export function orderOperationItems(context: OrderOperationContext): OrderOperationItem[] {
  return OPERATION_BUILDERS
    .map((build) => build(context))
    .filter((item): item is OrderOperationItem => item !== null);
}

/** 两个业务入口共用同一份可执行运营菜单；不可执行动作直接隐藏。 */
export function orderOperationMenuItems(
  context: OrderOperationContext,
  options: { allowProfileAfterSold?: boolean } = {},
) {
  const items = orderOperationItems(context);
  if (options.allowProfileAfterSold && context.row.status === "SOLD") {
    return [DESCRIPTION_OPERATION, IMAGES_OPERATION];
  }
  return items;
}

export function authorizedOrderOperationItems(items: OrderOperationItem[], can: (permission: string) => boolean) {
  if (!can("order.event.post")) return [];
  return items.filter((item) => item.key === "consignment" || can("order.update"));
}

export { OrderConsignmentModal } from "./consignment";
export { CONSIGNMENT_OPERATION } from "./consignment";
export { OrderPlatformOffsaleModal, consignmentRecords } from "./offsale";
export { OFFSALE_OPERATION } from "./offsale";
export { OrderProfileModal } from "./profile-modal";
export { DESCRIPTION_OPERATION } from "./description";
export { IMAGES_OPERATION } from "./images";
export type { ActiveConsignment } from "./offsale";
export type { OrderProfileTarget } from "./profile-modal";
export type { OrderOperationContext, OrderOperationItem, OrderOperationKey } from "./types";
