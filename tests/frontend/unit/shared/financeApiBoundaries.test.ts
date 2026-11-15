import { describe, expect, it } from "vitest";
import { depositsApi } from "@/shared/api/deposits.api";
import { reconciliationsApi } from "@/shared/api/reconciliations.api";
import { studioExpensesApi } from "@/shared/api/studioExpenses.api";
import { transfersApi } from "@/shared/api/transfers.api";
import { orderCashflowsApi } from "@/shared/api/orderCashflows.api";
import { useCashflowResources } from "@/pools/useCashflowResources";

describe("资金中心 API 边界", () => {
  it("押金、划转、对账各自从独立模块提供", () => {
    expect(depositsApi).toBeDefined();
    expect(transfersApi).toBeDefined();
    expect(reconciliationsApi).toBeDefined();
    expect(studioExpensesApi).toBeDefined();
    expect(orderCashflowsApi).toBeDefined();
    expect(useCashflowResources).toBeDefined();
  });
});
