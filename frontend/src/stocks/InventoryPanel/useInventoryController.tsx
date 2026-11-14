import { useSession } from "../../shared/state/session";
import { type BusinessCenterEntryTab } from "../../orders/businessCenter";
import { useAccountExecutionEditor } from "../account-edit/use-account-execution-editor";
import { useInventoryList } from "./useInventoryList";
import { useExecutionCache } from "./useExecutionCache";
import { useInventoryActions } from "./useInventoryActions";
import { useInventoryColumns } from "./useInventoryColumns";
import { mergeInventoryAccount } from "./types";

export function useInventoryController({ refreshKey = 0, active = true, onOrdersChanged, onNavigate }: { refreshKey?: number; active?: boolean; onOrdersChanged?: () => void; onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void }) {
  // 删除不可逆：按钮按系统角色显隐，后端仍做管理员二次鉴权。
  const { role } = useSession();
  const canDelete = role === "admin";

  // —— 列表域：加载 / 筛选 / 分页 / 排序 / 统计 / 派生行 / 导出 ——
  const list = useInventoryList({ active, refreshKey });
  const {
  rows,
  setRows,
  inventoryStats,
  businessMode,
  setBusinessMode,
  inventoryType,
  setInventoryType,
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
  businessOptions,
  inventoryTypeOptions,
  gameTypeOptions,
  load,
  countInventoryRows,
  visibleRows,
  orderedRows,
  handleExport,
  exporting,
  locallyRemovedIdsRef,
  } = list;

  // —— 详情缓存域：明细缓存 + 展开滚动记忆（注入列表的 setRows/setError / 本地移除集合）——
  const cache = useExecutionCache({ setRows, setError, locallyRemovedIdsRef });
  const {
  expandedOrderIds,
  loadExecution,
  loadOrderExecution,
  executionDetails,
  setExecutionDetails,
  executionLoading,
  orderExecutionDetails,
  orderExecutionLoading,
  dropExecutionCache,
  removeFromInventory,
  refreshExecution,
  expandTo,
  } = cache;

  // —— 账号台账内联编辑状态机（onSaved 回写详情缓存与列表行）——
  const accountEditor = useAccountExecutionEditor({
    getExecutionDetail: (accountId) => executionDetails[accountId],
    onSaved: (accountId, detail) => {
      setExecutionDetails((current) => ({ ...current, [accountId]: detail }));
      setRows((current) => current.map((row) => row.account.id === accountId ? mergeInventoryAccount(row, detail.account) : row));
    },
  });
  const {
    editingAccount,
    inlineEditId,
    eventDrafts,
    updateEventDraft,
    financeDrafts,
    updateFinanceDraft,
    updateEditingAccount,
    orderDrafts,
    updateOrderDraft,
    partyDrafts,
    updatePartyDraft,
    employees,
    invEditExtraForm,
    savingAccount,
  } = accountEditor;
  const saveInline = accountEditor.saveInline;

  // —— 业务动作域：open* / submit* / 删除下架 / 运营动作 ——
  const actions = useInventoryActions({
    load, setRows, setError,
    executionDetails, setExecutionDetails, loadExecution, loadOrderExecution, dropExecutionCache,
    expandTo, expandedOrderIds, removeFromInventory,
    editorOpenEditor: accountEditor.openEditor,
    editorCancelInlineEdit: accountEditor.cancelInlineEdit,
    inlineEditId,
    onOrdersChanged, onNavigate,
  });
  const {
  saleTarget,
  setSaleTarget,
  consignmentTarget,
  setConsignmentTarget,
  rebateTarget,
  setRebateTarget,
  cashflowTarget,
  setCashflowTarget,
  cashflowPools,
  profileTarget,
  setProfileTarget,
  detailTarget,
  setDetailTarget,
  voidTarget,
  setVoidTarget,
  voidPools,
  voidForm,
  voiding,
  submitVoid,
  platformOffsaleTarget,
  setPlatformOffsaleTarget,
  deleteTarget,
  setDeleteTarget,
  deleting,
  submitDelete,
  openProfile,
  openEditor,
  cancelInlineEdit,
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
    canDelete, editingAccount, executionDetails, loadExecution,
    setSaleTarget, setConsignmentTarget, setRebateTarget, setDeleteTarget,
    openCashflow, openPlatformOffsale, openEditor, handleInventoryAction,
  });

  return {
    active,
    arrangeColumns,
    businessMode,
    businessOptions,
    canDelete,
    cancelInlineEdit,
    cashflowPools,
    cashflowTarget,
    columns,
    consignmentTarget,
    countInventoryRows,
    dateRange,
    deleteTarget,
    deleting,
    detailTarget,
    dropExecutionCache,
    editingAccount,
    employees,
    error,
    eventDrafts,
    financeDrafts,
    executionDetails,
    executionLoading,
    orderExecutionDetails,
    orderExecutionLoading,
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
    keyword,
    load,
    loadExecution,
    loadOrderExecution,
    mobileFieldOrder,
    onNavigate,
    onOrdersChanged,
    openDetail,
    openEditor,
    openPartyCard,
    openPlatformOffsale,
    openProfile,
    openVoid,
    orderedRows,
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
    setCashflowTarget,
    setConsignmentTarget,
    setDateRange,
    setDeleteTarget,
    setDetailTarget,
    setError,
    setExecutionDetails,
    setGameTypeFilter,
    setInventoryType,
    setKeyword,
    setPage,
    setPageSize,
    setPlatformOffsaleTarget,
    setProfileTarget,
    setRebateTarget,
    setRows,
    setSaleTarget,
    setSortDesc,
    setVoidTarget,
    sortDesc,
    submitDelete,
    submitVoid,
    updateEventDraft,
    updateFinanceDraft,
    updateEditingAccount,
    orderDrafts,
    updateOrderDraft,
    partyDrafts,
    updatePartyDraft,
    visibleRows,
    voidForm,
    voidPools,
    voidTarget,
    voiding,
  };
}

export type InventoryController = ReturnType<typeof useInventoryController>;
