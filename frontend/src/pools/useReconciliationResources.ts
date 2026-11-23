import { reconciliationsApi } from "../shared/api/reconciliations.api";
import { useFundsPagination } from "./useFundsPagination";

/** 资金对账读取域：对账记录列表。 */
export function useReconciliationResources() {
  const resource = useFundsPagination(reconciliationsApi.page);
  return {
    reconciliations: resource.items,
    reconciliationsReady: resource.ready,
    reconciliationsLoading: resource.loading,
    reconciliationsError: resource.error,
    loadReconciliations: resource.load,
    reconciliationsPaging: resource.paging,
    setReconciliationsPage: resource.setPage,
  };
}
