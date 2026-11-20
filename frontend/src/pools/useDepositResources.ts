import { useCallback, useState } from "react";
import { depositsApi } from "../shared/api/deposits.api";
import type { Deposit } from "../shared/api/types/finance";

/** 押金读取域：押金占用列表。 */
export function useDepositResources() {
  const [deposits, setDeposits] = useState<Deposit[]>([]);

  const loadDeposits = useCallback(async (isCurrent: () => boolean) => {
    const items = await depositsApi.list();
    if (isCurrent()) setDeposits(items);
  }, []);

  return { deposits, loadDeposits };
}
