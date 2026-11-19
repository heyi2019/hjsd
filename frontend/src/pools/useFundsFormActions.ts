import { useEffect } from "react";
import type { Reconciliation } from "../shared/api/types/finance";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { useCashflowActions } from "./useCashflowActions";
import { useDepositActions } from "./useDepositActions";
import { useReconciliationActions } from "./useReconciliationActions";
import { useTransferActions } from "./useTransferActions";

/** 资金中心写操作层：全部弹窗表单、目标状态与提交处理器。
 *  逐字切片自原 useFundsPageController；load/balances/reconciliations/write 由主 controller 注入，
 *  避免与数据层形成循环依赖。 */
interface FundsFormActionsDeps {
  load: () => Promise<void>;
  reconciliations: Reconciliation[];
  write: ReturnType<typeof useAsyncAction>;
}

export function useFundsFormActions({ load, reconciliations, write }: FundsFormActionsDeps) {
  const cashflow = useCashflowActions({ load, write });
  const deposit = useDepositActions({ load, write });
  const reconciliation = useReconciliationActions({ load, reconciliations, write });
  const transfer = useTransferActions({ load, write });

  // L1527-①：全部资金弹窗共用同一 write.error。任一弹窗开/关切换时清除该错误，
  // 避免 A 弹窗提交失败后其 alert 在 B 弹窗（或重新打开 A）中残留。
  // 提交失败停留当前弹窗时 open 态不变，错误仍可见；仅状态切换（开/关）触发清理。
  useEffect(() => {
    write.clearError();
  }, [
    deposit.depositOpen,
    cashflow.cashflowOpen,
    transfer.transferOpen,
    reconciliation.reconciliationOpen,
    reconciliation.resolveTarget,
    deposit.returnTarget,
    deposit.lossTarget,
    deposit.cancelTarget,
    write.clearError,
  ]);

  return {
    ...cashflow,
    ...deposit,
    ...reconciliation,
    ...transfer,
  };
}
