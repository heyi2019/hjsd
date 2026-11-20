import { useCallback, useState } from "react";
import { normalizeError, type NormalizedError } from "../shared/api/client";
import { useLatestRequest } from "../shared/hooks/useLatestRequest";
import { reconciliationsApi } from "../shared/api/reconciliations.api";
import type { Reconciliation } from "../shared/api/types/finance";

/** 资金对账读取域：对账记录列表。 */
export function useReconciliationResources() {
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);
  const [reconciliationsReady, setReconciliationsReady] = useState(false);
  const [reconciliationsLoading, setReconciliationsLoading] = useState(false);
  const [reconciliationsError, setReconciliationsError] = useState<NormalizedError | null>(null);
  const request = useLatestRequest();

  const loadReconciliations = useCallback(async () => {
    const id = request.start();
    setReconciliationsReady(false);
    setReconciliationsLoading(true);
    setReconciliationsError(null);
    try {
      const items = await reconciliationsApi.list();
      if (!request.isCurrent(id)) return;
      setReconciliations(items);
      setReconciliationsReady(true);
    } catch (err) {
      if (request.isCurrent(id)) setReconciliationsError(normalizeError(err));
    } finally {
      if (request.isCurrent(id)) setReconciliationsLoading(false);
    }
  }, [request]);

  return { reconciliations, reconciliationsReady, reconciliationsLoading, reconciliationsError, loadReconciliations };
}
