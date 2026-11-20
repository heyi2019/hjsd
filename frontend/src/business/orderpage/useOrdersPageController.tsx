

import { useEffect, useRef, useState } from "react";
import type { Order } from "../../shared/api/types/orders";
import { currentDevUser } from "../../shared/api/client";
import type { BusinessOrderType } from "../CreateBusinessModal";
import { DEFAULT_BUSINESS_CENTER_TAB, type BusinessCenterEntryTab, type BusinessCenterTab } from "../businessCenter";
import { useLedgerList } from "./useLedgerList";
import type { InitialLedgerFilters } from "./useLedgerList";
import { useLedgerColumns } from "./useLedgerColumns";
import { useOrderCancellation } from "./useOrderCancellation";
import { useOrderActionModals } from "./useOrderActionModals";
import { mergeLedgerOrderWithDetail, useLedgerInlineEdit } from "./useLedgerInlineEdit";
import { useSession } from "../../shared/state/session";
import { useLatestRequest } from "../../shared/hooks/useLatestRequest";

export function useOrdersPageController(params: {
  active?: boolean;
  initialTab?: BusinessCenterEntryTab;
  initialMine?: boolean;
  initialLedgerFilters?: InitialLedgerFilters;
  initialAllocationOrderId?: number;
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
} = {}) {
  const { active = true, initialTab, initialMine = false, initialLedgerFilters, initialAllocationOrderId, onNavigate } = params;
  const currentOperator = currentDevUser();
  const { role, username } = useSession();
  const canDeleteOrder = role === "admin";

  const normalizedInitialTab: BusinessCenterTab = initialTab ?? DEFAULT_BUSINESS_CENTER_TAB;
  const [activeTab, setActiveTab] = useState<BusinessCenterTab>(normalizedInitialTab);
  useEffect(() => {
    setActiveTab(normalizedInitialTab);
  }, [normalizedInitialTab]);

  // —— 列表域：加载 / 筛选 / 分页 / 排序 / 导出 / 选项词典 / 派生 filteredOrders ——
  const list = useLedgerList({ active: active && activeTab === "ledger", initialMine, initialFilters: initialLedgerFilters });
  const {
    orders, setOrders, types, setTypes, loadError, setLoadError, loading, setLoading,
    page, setPage, pageSize, setPageSize,
    ledgerSortDesc, setLedgerSortDesc, ledgerExporting, setLedgerExporting,
    exportLedger, exportLedgerXlsx,
    orderTypeFilter, setOrderTypeFilter, businessModeFilter, setBusinessModeFilter,
    gameTypeFilter, setGameTypeFilter, inventoryStatusFilter, setInventoryStatusFilter,
    inventoryOperatorIds, setInventoryOperatorIds, saleOperatorIds, setSaleOperatorIds, myOperator, mineOrders, setMineOrders,
    dateRange, setDateRange, keyword, setKeyword,
    orderBusinessOptions, orderBusinessModeOptions, inventoryStatusOptions,
    gameTypeOptions, typeNames, filteredOrders, pageTotal, ledgerSummary, summaryLoading, summaryError, load,
  } = list;

  // —— 建单入口 / 当前选中订单（跨域共享枢纽） ——
  const [createType, setCreateType] = useState<BusinessOrderType | undefined>();
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const actionRequest = useLatestRequest();

  // —— 表格详情 / 账号内联编辑枢纽 ——
  const inlineEdit = useLedgerInlineEdit({
    actionRequest,
    onDetailSaved: (detail) => {
      setOrders((current) => current.map((order) => order.account_id === detail.account.id
        ? mergeLedgerOrderWithDetail(order, detail)
        : order));
    },
  });
  const { loadLedgerDetail, openLedgerEditor, ensureEmployees } = inlineEdit;
  useEffect(() => {
    if (active && activeTab === "ledger") void ensureEmployees();
  }, [active, activeTab]);

  // —— 冲销 / 取消域：分笔冲销、原路退款、分期合约取消 ——
  const cancellation = useOrderCancellation({ selectedOrder, setSelectedOrder, load, actionRequest });
  const {
    cancelEmployees, setCancelEmployees, cancelForm,
    cancelInstallmentTarget, setCancelInstallmentTarget,
    cancelOrderTarget, setCancelOrderTarget,
    cancelPools, setCancelPools, cancelScope, setCancelScope,
    cancelSubmitting,
    cancelableEventsForScope, reversibleEvents,
    closeCancelTransaction, openCancelTransaction, submitCancelTransaction,
    sharedCancellationEvent, hasSharedCancellation,
  } = cancellation;

  // —— 订单动作弹窗域：退款 / 分润配置 / 交付 / 下架 / 账号动作 ——
  // 子 hook 内部持有全部弹窗状态；主 hook 用 spread 并集保持对外返回契约不变。
  const actionModals = useOrderActionModals({ selectedOrder, load, actionRequest });
  // openOrderProfile 仅供台账列定义内部点击转发，原本不在对外 return 契约中。
  const { openOrderProfile, ...exposedActionModals } = actionModals;
  const {
    openAllocations, openRefund,
    openOrderRebate, openOrderSale, openOrderConsignment, openOrderOffsale, openOrderDelete,
  } = actionModals;

  const allocationDeepLinkOpened = useRef<number | null>(null);
  useEffect(() => {
    if (!active || activeTab !== "ledger" || !initialAllocationOrderId || allocationDeepLinkOpened.current === initialAllocationOrderId) return;
    const target = orders.find((order) => order.id === initialAllocationOrderId);
    if (!target) return;
    allocationDeepLinkOpened.current = initialAllocationOrderId;
    void openAllocations(target);
  }, [active, activeTab, initialAllocationOrderId, openAllocations, orders]);

  const [inventoryRefreshKey, setInventoryRefreshKey] = useState(0);
  const [installmentRefreshKey, setInstallmentRefreshKey] = useState(0);


  // —— 台账列定义域：纯展示配置 + 点击转发 ——
  const { arrangeLedgerColumns, visibleLedgerColumns } = useLedgerColumns({
    canDeleteOrder,
    ledgerDetails: inlineEdit.ledgerDetails,
    loadLedgerDetail,
    openLedgerEditor,
    openAllocations,
    openRefund,
    openOrderProfile,
    openOrderRebate,
    openOrderSale,
    openOrderConsignment,
    openCancelTransaction,
    openOrderOffsale,
    openOrderDelete,
  });

  return {
    ...exposedActionModals,
    ...inlineEdit,
    activeTab: activeTab,
    arrangeLedgerColumns: arrangeLedgerColumns,
    businessModeFilter: businessModeFilter,
    cancelEmployees: cancelEmployees,
    cancelForm: cancelForm,
    cancelInstallmentTarget: cancelInstallmentTarget,
    cancelOrderTarget: cancelOrderTarget,
    cancelPools: cancelPools,
    cancelScope: cancelScope,
    cancelSubmitting: cancelSubmitting,
    cancelableEventsForScope: cancelableEventsForScope,
    closeCancelTransaction: closeCancelTransaction,
    createType: createType,
    currentOperator: currentOperator,
    dateRange: dateRange,
    filteredOrders: filteredOrders,
    ledgerSummary: ledgerSummary,
    summaryLoading: summaryLoading,
    summaryError: summaryError,
    gameTypeFilter: gameTypeFilter,
    gameTypeOptions: gameTypeOptions,
    hasSharedCancellation: hasSharedCancellation,
    installmentRefreshKey: installmentRefreshKey,
    inventoryRefreshKey: inventoryRefreshKey,
    inventoryStatusFilter: inventoryStatusFilter,
    inventoryOperatorIds: inventoryOperatorIds,
    inventoryStatusOptions: inventoryStatusOptions,
    keyword: keyword,
    ledgerColumns: visibleLedgerColumns,
    ledgerExporting: ledgerExporting,
    ledgerSortDesc: ledgerSortDesc,
    load: load,
    loadError: loadError,
    loading: loading,
    onExportLedger: exportLedger,
    onExportLedgerXlsx: exportLedgerXlsx,
    openCancelTransaction: openCancelTransaction,
    orderBusinessModeOptions: orderBusinessModeOptions,
    orderBusinessOptions: orderBusinessOptions,
    operatorUsername: username,
    orderTypeFilter: orderTypeFilter,
    orders: orders,
    page: page,
    pageSize: pageSize,
    pageTotal: pageTotal,
    reversibleEvents: reversibleEvents,
    selectedOrder: selectedOrder,
    setActiveTab: setActiveTab,
    setBusinessModeFilter: setBusinessModeFilter,
    setCancelEmployees: setCancelEmployees,
    setCancelInstallmentTarget: setCancelInstallmentTarget,
    setCancelOrderTarget: setCancelOrderTarget,
    setCancelPools: setCancelPools,
    setCancelScope: setCancelScope,
    setCreateType: (value: Parameters<typeof setCreateType>[0]) => { actionRequest.invalidate(); setCreateType(value); },
    setDateRange: setDateRange,
    setGameTypeFilter: setGameTypeFilter,
    setInstallmentRefreshKey: setInstallmentRefreshKey,
    setInventoryRefreshKey: setInventoryRefreshKey,
    setInventoryStatusFilter: setInventoryStatusFilter,
    setInventoryOperatorIds: setInventoryOperatorIds,
    setKeyword: setKeyword,
    setLedgerExporting: setLedgerExporting,
    setLedgerSortDesc: setLedgerSortDesc,
    setLoadError: setLoadError,
    setLoading: setLoading,
    setOrderTypeFilter: setOrderTypeFilter,
    saleOperatorIds: saleOperatorIds,
    setSaleOperatorIds: setSaleOperatorIds,
    myOperator: myOperator,
    mineOrders: mineOrders,
    setMineOrders: setMineOrders,
    setOrders: setOrders,
    setPage: setPage,
    setPageSize: setPageSize,
    setSelectedOrder: setSelectedOrder,
    setTypes: setTypes,
    sharedCancellationEvent: sharedCancellationEvent,
    submitCancelTransaction: submitCancelTransaction,
    typeNames: typeNames,
    types: types,
  };

}

export type OrdersPageController = ReturnType<typeof useOrdersPageController>;
