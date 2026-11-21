import { useCallback, useRef, useState } from "react";
import { normalizeError, type NormalizedError } from "../shared/api/client";
import { useLatestRequest } from "../shared/hooks/useLatestRequest";
import { reconciliationsApi } from "../shared/api/reconciliations.api";
import type { Reconciliation } from "../shared/api/types/finance";

/** 资金对账读取域：对账记录列表。 */
export function useReconciliationResources() {
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);
  const [paging, setPaging] = useState({ page: 1, pageSize: 10, total: 0 });
  const pagingRef = useRef(paging);
  pagingRef.current = paging;
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
      let selected = pagingRef.current;
      let result = await reconciliationsApi.page({ limit: selected.pageSize, offset: (selected.page - 1) * selected.pageSize });
      if (!request.isCurrent(id)) return;
      const lastPage = Math.max(1, Math.ceil(result.total / selected.pageSize));
      if (selected.page > lastPage) {
        selected = { ...selected, page: lastPage };
        result = await reconciliationsApi.page({ limit: selected.pageSize, offset: (lastPage - 1) * selected.pageSize });
        if (!request.isCurrent(id)) return;
      }
      const next = { ...selected, total: result.total };
      pagingRef.current = next;
      setPaging(next);
      setReconciliations(result.items);
      setReconciliationsReady(true);
    } catch (err) {
      if (request.isCurrent(id)) setReconciliationsError(normalizeError(err));
    } finally {
      if (request.isCurrent(id)) setReconciliationsLoading(false);
    }
  }, [request]);

  const setReconciliationsPage = (page: number, pageSize: number) => {
    const next = { ...pagingRef.current, page: pageSize === pagingRef.current.pageSize ? page : 1, pageSize };
    pagingRef.current = next;
    setPaging(next);
    void loadReconciliations();
  };

  return { reconciliations, reconciliationsReady, reconciliationsLoading, reconciliationsError, loadReconciliations, reconciliationsPaging: paging, setReconciliationsPage };
}
