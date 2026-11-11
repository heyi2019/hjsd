import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { useFundsResources } from "./useFundsResources";
import { useFundsFormActions } from "./useFundsFormActions";

/** 资金中心逻辑层总入口：组合数据/查询层与写操作层，冻结对外返回契约。
 *  与拆分前 useFundsPageController 的 91 字段返回契约逐字段一致（spread 并集，两子层字段互斥）。 */
export function useFundsPageController(active = true) {
  // 弹窗不会同时打开，故全部写操作后共用一个 pending/error 即可覆盖。
  const write = useAsyncAction();
  const resources = useFundsResources(active);
  const actions = useFundsFormActions({
    load: resources.load,
    balances: resources.balances,
    reconciliations: resources.reconciliations,
    write,
  });
  return { active, ...resources, ...actions, write };
}

export type FundsPageController = ReturnType<typeof useFundsPageController>;
