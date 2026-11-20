import { useMemo, useRef, useState } from "react";
import { ordersApi } from "../../shared/api/orders.api";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Order } from "../../shared/api/types/orders";
import { normalizeError } from "../../shared/api/client";
import { appMessage } from "../../shared/ui/appFeedback";
import { useOrderDetailEditor } from "../OrderDetailView/editing/use-order-detail-editor";

export function mergeLedgerOrderWithDetail(order: Order, detail: Pick<AccountExecutionDetail, "account">): Order {
  const { account } = detail;
  return {
    ...order,
    account_game_type: account.game_type ?? order.account_game_type,
    account_game_account: account.game_account ?? order.account_game_account,
    account_status: account.status ?? order.account_status,
    cost_amount: account.cost_amount ?? order.cost_amount,
    stock_no: account.stock_no ?? order.stock_no,
  };
}

/**
 * 台账表格的展开详情缓存与账号内联编辑枢纽。
 * 订单与库存必须已有明确绑定，编辑器不负责补建库存档案。
 */
export function useLedgerInlineEdit(params: { onDetailSaved?: (detail: AccountExecutionDetail) => void } = {}) {
  const [expandedOrderIds, setExpandedOrderIds] = useState<string[]>([]);
  const [ledgerOrderDetails, setLedgerOrderDetails] = useState<Record<number, AccountExecutionDetail>>({});
  const [ledgerOrderDetailLoading, setLedgerOrderDetailLoading] = useState<Record<number, boolean>>({});
  const detailRequestsRef = useRef<Partial<Record<number, Promise<AccountExecutionDetail | null>>>>({});
  const detailVersionsRef = useRef<Record<number, number>>({});
  const editIntentRef = useRef(0);
  const invalidateDetailRequest = (orderId: number) => {
    detailVersionsRef.current[orderId] = (detailVersionsRef.current[orderId] ?? 0) + 1;
    delete detailRequestsRef.current[orderId];
    setLedgerOrderDetailLoading((current) => ({ ...current, [orderId]: false }));
  };
  const loadLedgerDetail = async (order: Pick<Order, "id" | "account_id">, force = false) => {
    if (order.account_id == null) return;
    await loadLedgerOrderDetail(order.id, force);
  };
  const loadLedgerOrderDetail = async (orderId: number, force = false): Promise<AccountExecutionDetail | null> => {
    if (!force && ledgerOrderDetails[orderId]) return ledgerOrderDetails[orderId];
    if (!force && detailRequestsRef.current[orderId]) return detailRequestsRef.current[orderId];
    const version = (detailVersionsRef.current[orderId] ?? 0) + 1;
    detailVersionsRef.current[orderId] = version;
    setLedgerOrderDetailLoading((current) => ({ ...current, [orderId]: true }));
    const request = ordersApi.executionDetail(orderId)
      .then(async (detail) => {
        if (detailVersionsRef.current[orderId] !== version) return null;
        setLedgerOrderDetails((current) => ({ ...current, [orderId]: detail }));
        void orderDetailEditor.ensureEmployees();
        return detail;
      })
      .catch((error) => {
        if (detailVersionsRef.current[orderId] === version) appMessage.error(normalizeError(error).message);
        return null;
      })
      .finally(() => {
        if (detailVersionsRef.current[orderId] !== version) return;
        delete detailRequestsRef.current[orderId];
        setLedgerOrderDetailLoading((current) => ({ ...current, [orderId]: false }));
      });
    detailRequestsRef.current[orderId] = request;
    return request;
  };
  const orderDetailEditor = useOrderDetailEditor({
    getExecutionDetail: (id) => Object.values(ledgerOrderDetails).find((detail) => detail.account.id === id),
    onSaved: (id, detail) => {
      detail.orders.forEach((order) => invalidateDetailRequest(order.order_id));
      setLedgerOrderDetails((current) => Object.fromEntries(
        Object.entries(current).map(([orderId, cached]) => cached.account.id === id ? [orderId, detail] : [orderId, cached]),
      ));
      params.onDetailSaved?.(detail);
    },
    onRefreshFailed: (accountId, orderId) => {
      invalidateDetailRequest(orderId);
      setLedgerOrderDetails((current) => Object.fromEntries(
        Object.entries(current).filter(([, cached]) => cached.account.id !== accountId),
      ));
      setExpandedOrderIds([]);
    },
  });

  const openLedgerEditor = async (order: Order) => {
    try {
      const accountId = order.account_id;
      if (accountId == null) {
        appMessage.warning("该订单未关联库存账号，无法编辑账号资料");
        return;
      }
      if (orderDetailEditor.isSaving()) {
        appMessage.warning("当前订单正在保存，请稍候");
        return;
      }
      const intent = ++editIntentRef.current;
      orderDetailEditor.cancelPendingOpen();
      const detail = await loadLedgerOrderDetail(order.id);
      if (!detail || intent !== editIntentRef.current) return;
      const opened = await orderDetailEditor.openEditor(detail.account);
      if (opened && intent === editIntentRef.current) setExpandedOrderIds([String(order.id)]);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const ledgerDetails = useMemo(
    () => Object.fromEntries(Object.values(ledgerOrderDetails).map((detail) => [detail.account.id, detail])),
    [ledgerOrderDetails],
  );

  const handleLedgerExpand = (expanded: boolean, record: Order) => {
    if (orderDetailEditor.isSaving()) {
      appMessage.warning("当前订单正在保存，请稍候");
      return;
    }
    editIntentRef.current += 1;
    orderDetailEditor.cancelPendingOpen();
    // 手风琴：一次只展开一行，避免多行展开同时挂载多份详情导致 DOM 与页面长度翻倍。
    setExpandedOrderIds(expanded ? [String(record.id)] : []);
    if (expanded) void loadLedgerOrderDetail(record.id);
  };

  const cancelInlineEdit = () => {
    if (!orderDetailEditor.isSaving()) editIntentRef.current += 1;
    orderDetailEditor.cancelInlineEdit();
  };

  const saveInline = async () => {
    if (orderDetailEditor.isSaving()) return;
    editIntentRef.current += 1;
    orderDetailEditor.cancelPendingOpen();
    await orderDetailEditor.saveInline();
  };

  // orderDetailEditor 还持有 openEditor（仅本 hook 内部使用），对外只暴露原契约中的 12 个键。
  return {
    expandedOrderIds,
    setExpandedOrderIds,
    ledgerDetails,
    ledgerDetailLoading: {},
    loadLedgerDetail,
    ledgerOrderDetails,
    ledgerOrderDetailLoading,
    loadLedgerOrderDetail,
    openLedgerEditor,
    handleLedgerExpand,
    cancelInlineEdit,
    editingAccount: orderDetailEditor.editingAccount,
    employees: orderDetailEditor.employees,
    ensureEmployees: orderDetailEditor.ensureEmployees,
    pools: orderDetailEditor.pools,
    eventDrafts: orderDetailEditor.eventDrafts,
    operationDrafts: orderDetailEditor.operationDrafts,
    financeDrafts: orderDetailEditor.financeDrafts,
    inlineEditId: orderDetailEditor.inlineEditId,
    invEditExtraForm: orderDetailEditor.invEditExtraForm,
    saveInline,
    savingAccount: orderDetailEditor.savingAccount,
    updateEventDraft: orderDetailEditor.updateEventDraft,
    updateOperationDraft: orderDetailEditor.updateOperationDraft,
    addOperationDraft: orderDetailEditor.addOperationDraft,
    removeOperationDraft: orderDetailEditor.removeOperationDraft,
    updateFinanceDraft: orderDetailEditor.updateFinanceDraft,
    updateEditingAccount: orderDetailEditor.updateEditingAccount,
    orderDrafts: orderDetailEditor.orderDrafts,
    updateOrderDraft: orderDetailEditor.updateOrderDraft,
    partyDrafts: orderDetailEditor.partyDrafts,
    updatePartyDraft: orderDetailEditor.updatePartyDraft,
  };
}
