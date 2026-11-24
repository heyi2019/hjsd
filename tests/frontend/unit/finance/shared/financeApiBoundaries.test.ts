import { describe, expect, it } from "vitest";
import { depositsApi } from "@/shared/api/deposits.api";
import { reconciliationsApi } from "@/shared/api/reconciliations.api";
import { studioExpensesApi } from "@/shared/api/studioExpenses.api";
import { transfersApi } from "@/shared/api/transfers.api";
import { orderCashflowsApi } from "@/shared/api/orderCashflows.api";
import { useCashflowResources } from "@/finance/cashflow/useCashflowResources";
import { useDepositActions } from "@/finance/deposits/useDepositActions";
import { useDepositResources } from "@/finance/deposits/useDepositResources";
import { usePoolResources } from "@/finance/usePoolResources";
import { useReconciliationActions } from "@/finance/reconciliation/useReconciliationActions";
import { useReconciliationResources } from "@/finance/reconciliation/useReconciliationResources";
import { useTransferActions } from "@/finance/useTransferActions";
import { mergeFormExtra } from "@/shared/lib/formExtra";

describe("资金中心 API 边界", () => {
  it("押金、划转、对账各自从独立模块提供", () => {
    expect(depositsApi).toBeDefined();
    expect(transfersApi).toBeDefined();
    expect(reconciliationsApi).toBeDefined();
    expect(studioExpensesApi).toBeDefined();
    expect(orderCashflowsApi).toBeDefined();
    expect(useCashflowResources).toBeDefined();
    expect(useDepositActions).toBeDefined();
    expect(useDepositResources).toBeDefined();
    expect(usePoolResources).toBeDefined();
    expect(useReconciliationActions).toBeDefined();
    expect(useReconciliationResources).toBeDefined();
    expect(useTransferActions).toBeDefined();
  });

  it("清空自定义字段时保留零、关闭状态和未修改的历史字段", () => {
    expect(mergeFormExtra(
      { amount: 0, enabled: false, cleared: null, emptyChoices: [] },
      { cleared: "旧值", emptyChoices: ["旧选项"], history: "其他操作记录" },
    )).toEqual({ amount: 0, enabled: false, history: "其他操作记录" });
  });
});
