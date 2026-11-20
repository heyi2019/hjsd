import { useCallback, useState } from "react";
import { normalizeError, type NormalizedError } from "../shared/api/client";
import { useLatestRequest } from "../shared/hooks/useLatestRequest";
import { depositsApi } from "../shared/api/deposits.api";
import type { Deposit } from "../shared/api/types/finance";

/** 押金读取域：押金占用列表。 */
export function useDepositResources() {
  const [deposits, setDeposits] = useState<Deposit[]>([]);
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
      const items = await depositsApi.list();
      if (!request.isCurrent(id)) return;
      setDeposits(items);
      setDepositsReady(true);
    } catch (err) {
      if (request.isCurrent(id)) setDepositsError(normalizeError(err));
    } finally {
      if (request.isCurrent(id)) setDepositsLoading(false);
    }
  }, [request]);

  return { deposits, depositsReady, depositsLoading, depositsError, loadDeposits };
}
