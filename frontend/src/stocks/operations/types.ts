import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";

export type InventoryOperationKey = "consignment" | "offsale" | "description" | "images";

export type InventoryOperationItem = {
  key: InventoryOperationKey;
  label: string;
};

export type InventoryOperationContext = {
  row: Pick<Account, "status" | "inventory_type">;
  detail?: AccountExecutionDetail;
};
