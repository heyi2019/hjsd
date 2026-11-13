import { consignmentOperation } from "./consignment";
import { descriptionOperation } from "./description";
import { imagesOperation } from "./images";
import { offsaleOperation } from "./offsale";
import type { InventoryOperationContext, InventoryOperationItem } from "./types";

const OPERATION_BUILDERS = [
  consignmentOperation,
  offsaleOperation,
  descriptionOperation,
  imagesOperation,
];

export function inventoryOperationItems(context: InventoryOperationContext): InventoryOperationItem[] {
  return OPERATION_BUILDERS
    .map((build) => build(context))
    .filter((item): item is InventoryOperationItem => item !== null);
}

export type { InventoryOperationContext, InventoryOperationItem, InventoryOperationKey } from "./types";
