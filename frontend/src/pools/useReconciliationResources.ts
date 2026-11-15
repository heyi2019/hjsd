import { useCallback, useState } from "react";
import { reconciliationsApi } from "../shared/api/reconciliations.api";
import type { Reconciliation } from "../shared/api/types/finance";

/** 资金对账读取域：对账记录列表。 */
export function useReconciliationResources() {
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);

  const loadReconciliations = useCallback(async () => {
    setReconciliations(await reconciliationsApi.list());
  }, []);

  return { reconciliations, loadReconciliations };
}
