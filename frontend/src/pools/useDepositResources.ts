import { useCallback, useRef, useState } from "react";
import { normalizeError, type NormalizedError } from "../shared/api/client";
import { useLatestRequest } from "../shared/hooks/useLatestRequest";
import { depositsApi } from "../shared/api/deposits.api";
import type { Deposit } from "../shared/api/types/finance";

/** 押金读取域：押金占用列表。 */
export function useDepositResources() {
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [paging, setPaging] = useState({ page: 1, pageSize: 10, total: 0 });
  const pagingRef = useRef(paging);
  pagingRef.current = paging;
  const [depositsReady, setDepositsReady] = useState(false);
  const [depositsLoading, setDepositsLoading] = useState(false);
  const [depositsError, setDepositsError] = useState<NormalizedError | null>(null);
  const request = useLatestRequest();

  const loadDeposits = useCallback(async () => {
    const id = request.start();
    setDepositsReady(false);
    setDepositsLoading(true);
    setDepositsError(null);
    try {
      let selected = pagingRef.current;
      let result = await depositsApi.page({ limit: selected.pageSize, offset: (selected.page - 1) * selected.pageSize });
      if (!request.isCurrent(id)) return;
      const lastPage = Math.max(1, Math.ceil(result.total / selected.pageSize));
      if (selected.page > lastPage) {
        selected = { ...selected, page: lastPage };
        result = await depositsApi.page({ limit: selected.pageSize, offset: (lastPage - 1) * selected.pageSize });
        if (!request.isCurrent(id)) return;
      }
      const next = { ...selected, total: result.total };
      pagingRef.current = next;
      setPaging(next);
      setDeposits(result.items);
      setDepositsReady(true);
    } catch (err) {
      if (request.isCurrent(id)) setDepositsError(normalizeError(err));
    } finally {
      if (request.isCurrent(id)) setDepositsLoading(false);
    }
  }, [request]);

  const setDepositsPage = (page: number, pageSize: number) => {
    const next = { ...pagingRef.current, page: pageSize === pagingRef.current.pageSize ? page : 1, pageSize };
    pagingRef.current = next;
    setPaging(next);
    void loadDeposits();
  };

  return { deposits, depositsReady, depositsLoading, depositsError, loadDeposits, depositsPaging: paging, setDepositsPage };
}
