import { useEffect } from "react";
import { useSession } from "../../../shared/state/session";
import { type BusinessCenterEntryTab } from "../../businessCenter";
import { useOrderDetailEditor } from "../../shared/order-detail/editing/use-order-detail-editor";
import { useInventoryList } from "./useInventoryList";
import { useExecutionCache } from "./useExecutionCache";
import { useInventoryActions } from "./useInventoryActions";
import { useInventoryColumns } from "./useInventoryColumns";
import { mergeInventoryAccount } from "./types";

export function useInventoryController({ refreshKey = 0, active = true, initialAgeGtDays, onNavigate }: { refreshKey?: number; active?: boolean; initialAgeGtDays?: number; onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void }) {
  const { username } = useSession();

  // —— 列表域：加载 / 筛选 / 分页 / 排序 / 统计 / 派生行 / 导出 ——
  const list = useInventoryList({ active, refreshKey, initialAgeGtDays });
  const {
  rows,
  setRows,
  inventoryStats,
  businessMode,
  setBusinessMode,
  inventoryType,
  setInventoryType,
  inventoryOperatorIds,
  setInventoryOperatorIds,
  ageGtDays,
  setAgeGtDays,
  gameTypeFilter,
  setGameTypeFilter,
  keyword,
  setKeyword,
  dateRange,
  setDateRange,
  sortDesc,
  setSortDesc,
  page,
  setPage,
  pageSize,
  setPageSize,
  error,
  setError,
  listLoading,
  listError,
  businessOptions,
  inventoryTypeOptions,
  gameTypeOptions,
  load,
  countInventoryRows,
  totalCount,
  handleExport,
  exporting,
  locallyRemovedIdsRef,
  markLocallyRemoved,
  } = list;

  // —— 详情缓存域：明细缓存 + 展开滚动记忆（注入列表的 setRows/setError / 本地移除集合）——
  const cache = useExecutionCache({ setRows, setError, locallyRemovedIdsRef });
  const {
  expandedOrderIds,
  loadExecution,
  loadOrderExecution,
  loadActionExecution,
  loadEditorExecution,
  executionDetails,
  setExecutionDetails,
  executionLoading,
  orderExecutionDetails,
  orderExecutionLoading,
  setOrderExecutionDetails,
  dropExecutionCache,
  dropOrderExecutionCache,
  removeFromInventory: removeFromCache,
  refreshExecution,
  expandTo,
  } = cache;
  const removeFromInventory = (accountId: number, orderId?: number) => {
    markLocallyRemoved(accountId);
    removeFromCache(accountId, orderId);
  };

  // —— 订单详情内联编辑状态机（onSaved 回写详情缓存与列表行）——
  const orderDetailEditor = useOrderDetailEditor({
    getExecutionDetail: (accountId) => executionDetails[accountId],
    onSaved: (accountId, detail) => {
      dropExecutionCache(accountId);
      detail.orders.forEach((order) => dropOrderExecutionCache(order.order_id));
      setExecutionDetails((current) => ({ ...current, [accountId]: detail }));
      setOrderExecutionDetails((current) => Object.fromEntries(
        Object.entries(current).map(([orderId, cached]) => cached.account.id === accountId ? [orderId, detail] : [orderId, cached]),
      ));
      setRows((current) => current.map((row) => row.account.id === accountId ? mergeInventoryAccount(row, detail.account) : row));
      void load();
    },
    onRefreshFailed: (accountId, orderId) => {
      dropExecutionCache(accountId);
      dropOrderExecutionCache(orderId);
      setExecutionDetails((current) => Object.fromEntries(
        Object.entries(current).filter(([id]) => Number(id) !== accountId),
      ));
      setOrderExecutionDetails((current) => Object.fromEntries(
        Object.entries(current).filter(([, detail]) => detail.account.id !== accountId),
      ));
      setDetailTarget(null);
      void load();
    },
  });
  useEffect(() => {
    if (active) void orderDetailEditor.ensureEmployees();
  }, [active]);
  const {
    editingAccount,
    inlineEditId,
    eventDrafts,
    updateEventDraft,
    operationDrafts,
    updateOperationDraft,
    addOperationDraft,
    removeOperationDraft,
    financeDrafts,
    updateFinanceDraft,
    updateEditingAccount,
    orderDrafts,
    updateOrderDraft,
    partyDrafts,
    updatePartyDraft,
    employees,
    pools,
    invEditExtraForm,
    savingAccount,
  } = orderDetailEditor;
  // —— 业务动作域：open* / submit* / 取消下架 / 运营动作 ——
  const actions = useInventoryActions({
    load, setRows, setError,
    loadExecution, loadOrderExecution, loadActionExecution, loadEditorExecution, dropExecutionCache,
    expandTo,
    editorOpenEditor: orderDetailEditor.openEditor,
    editorCancelInlineEdit: orderDetailEditor.cancelInlineEdit,
    editorCancelPendingOpen: orderDetailEditor.cancelPendingOpen,
    editorIsSaving: orderDetailEditor.isSaving,
    editorSaveInline: orderDetailEditor.saveInline,
    inlineEditId,
    onNavigate,
  });
  const {
  saleTarget,
  setSaleTarget,
  consignmentTarget,
  setConsignmentTarget,
  rebateTarget,
  setRebateTarget,
  cashflowTarget,
  closeCashflow,
  cashflowPools,
  cashflowUsers,
  profileTarget,
  setProfileTarget,
  detailTarget,
  setDetailTarget,
  voidTarget,
  closeVoid,
  voidPools,
  voidForm,
  voiding,
  submitVoid,
  platformOffsaleTarget,
  setPlatformOffsaleTarget,
  openProfile,
  openEditor,
  cancelInlineEdit,
  saveInline,
  openDetail,
  openVoid,
  openPlatformOffsale,
  handleInventoryAction,
  handleExpand,
  openPartyCard,
  openCashflow,
  } = actions;

  // —— 台账列定义域：15 列 + 移动端列编排（回调依赖注入）——
  const { columns, mobileFieldOrder, arrangeColumns } = useInventoryColumns({
    editingAccount, executionDetails, loadExecution,
    setSaleTarget: (value) => { actions.invalidatePendingActions(); setSaleTarget(value); },
    setConsignmentTarget: (value) => { actions.invalidatePendingActions(); setConsignmentTarget(value); },
    setRebateTarget: (value) => { actions.invalidatePendingActions(); setRebateTarget(value); },
    openCashflow, openPlatformOffsale, openEditor, handleInventoryAction,
  });

  return {
    active,
    arrangeColumns,
    businessMode,
    businessOptions,
    cancelInlineEdit,
    cashflowPools,
    cashflowUsers,
    cashflowTarget,
    columns,
    consignmentTarget,
    countInventoryRows,
    dateRange,
    detailTarget,
    dropExecutionCache,
    editingAccount,
    employees,
    pools,
    employeeError: orderDetailEditor.employeeError,
    poolError: orderDetailEditor.poolError,
    retryEmployees: orderDetailEditor.retryEmployees,
    retryPools: orderDetailEditor.retryPools,
    error,
    eventDrafts,
    operationDrafts,
    financeDrafts,
    executionDetails,
    executionLoading,
    orderExecutionDetails,
    orderExecutionLoading,
    operatorUsername: username,
    expandedOrderIds,
    exporting,
    gameTypeFilter,
    gameTypeOptions,
    handleExpand,
    handleExport,
    inlineEditId,
    invEditExtraForm,
    inventoryStats,
    inventoryType,
    inventoryTypeOptions,
    inventoryOperatorIds,
    ageGtDays,
    keyword,
    load,
    loadExecution,
    loadOrderExecution,
    mobileFieldOrder,
    onNavigate,
    openDetail,
    openEditor,
    openPartyCard,
    openPlatformOffsale,
    openProfile,
    openVoid,
    totalCount,
    listLoading,
    listError,
    page,
    pageSize,
    platformOffsaleTarget,
    profileTarget,
    rebateTarget,
    refreshExecution,
    removeFromInventory,
    rows,
    saleTarget,
    saveInline,
    savingAccount,
    setBusinessMode,
    closeCashflow,
    setConsignmentTarget,
    setDateRange,
    setDetailTarget,
    setError,
    setExecutionDetails,
    setGameTypeFilter,
    setInventoryType,
    setInventoryOperatorIds,
    setAgeGtDays,
    setKeyword,
    submitSearch: list.submitSearch,
    setPage,
    setPageSize,
    setPlatformOffsaleTarget,
    setProfileTarget,
    setRebateTarget,
    setRows,
    setSaleTarget,
    setSortDesc,
    closeVoid,
    sortDesc,
    submitVoid,
    updateEventDraft,
    updateOperationDraft,
    addOperationDraft,
    removeOperationDraft,
    updateFinanceDraft,
    updateEditingAccount,
    orderDrafts,
    updateOrderDraft,
    partyDrafts,
    updatePartyDraft,
    voidForm,
    voidPools,
    voidTarget,
    voiding,
  };
}

export type InventoryController = ReturnType<typeof useInventoryController>;
