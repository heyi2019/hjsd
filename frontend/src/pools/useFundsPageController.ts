import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { useFundsResources } from "./useFundsResources";
import { useFundsFormActions } from "./useFundsFormActions";
import type { PeriodState } from "../shared/state/businessPeriod";

/** 资金中心逻辑层总入口：组合查询与写入领域。 */
export function useFundsPageController(active: boolean, periodState: PeriodState) {
  // 弹窗不会同时打开，故全部写操作后共用一个 pending/error 即可覆盖。
  const write = useAsyncAction();
  const resources = useFundsResources(active, periodState);
  const actions = useFundsFormActions({
    load: resources.load,
    reconciliations: resources.reconciliations,
    write,
  });
  return { active, ...resources, ...actions, write };
}

export type FundsPageController = ReturnType<typeof useFundsPageController>;
