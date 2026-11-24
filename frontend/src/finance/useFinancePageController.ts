import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { useFinanceResources } from "./useFinanceResources";
import { useFinanceFormActions } from "./useFinanceFormActions";
import type { PeriodState } from "../shared/state/businessPeriod";

/** 资金中心逻辑层总入口：组合查询与写入领域。 */
export function useFinancePageController(active: boolean, periodState: PeriodState, cashflowsActive: boolean) {
  // 弹窗不会同时打开，故全部写操作后共用一个 pending/error 即可覆盖。
  const write = useAsyncAction();
  const resources = useFinanceResources(active, periodState, cashflowsActive);
  const actions = useFinanceFormActions({
    load: resources.load,
    reconciliations: resources.reconciliations,
    write,
  });
  return { active, ...resources, ...actions, write };
}

export type FinancePageController = ReturnType<typeof useFinancePageController>;
