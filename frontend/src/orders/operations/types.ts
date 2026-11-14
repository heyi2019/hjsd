import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";

export type OrderOperationKey = "consignment" | "offsale" | "description" | "images";

export type OrderOperationItem = {
  key: OrderOperationKey;
  label: string;
};

export type OrderOperationContext = {
  row: Pick<Account, "status" | "inventory_type">;
  detail?: AccountExecutionDetail;
};
