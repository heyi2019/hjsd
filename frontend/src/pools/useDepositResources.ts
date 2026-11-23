import { depositsApi } from "../shared/api/deposits.api";
import { useFundsPagination } from "./useFundsPagination";

/** 押金读取域：押金占用列表。 */
export function useDepositResources() {
  const resource = useFundsPagination(depositsApi.page);
  return {
    deposits: resource.items,
    depositsReady: resource.ready,
    depositsLoading: resource.loading,
    depositsError: resource.error,
    loadDeposits: resource.load,
    depositsPaging: resource.paging,
    setDepositsPage: resource.setPage,
  };
}
