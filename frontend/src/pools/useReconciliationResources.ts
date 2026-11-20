import { useCallback, useState } from "react";
import { reconciliationsApi } from "../shared/api/reconciliations.api";
import type { Reconciliation } from "../shared/api/types/finance";

/** 资金对账读取域：对账记录列表。 */
export function useReconciliationResources() {
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);

  const loadReconciliations = useCallback(async (isCurrent: () => boolean) => {
    const items = await reconciliationsApi.list();
    if (isCurrent()) setReconciliations(items);
  }, []);

  return { reconciliations, loadReconciliations };
}
