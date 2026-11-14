import { useMemo, useState } from "react";
import { ordersApi } from "../../shared/api/orders.api";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Order } from "../../shared/api/types/orders";
import { normalizeError } from "../../shared/api/client";
import { appMessage } from "../../shared/ui/appFeedback";
import { useOrderDetailEditor } from "../OrderDetailView/editing/use-order-detail-editor";

/**
 * 台账表格的展开详情缓存与账号内联编辑枢纽。
 * 订单与库存必须已有明确绑定，编辑器不负责补建库存档案。
 */
export function useLedgerInlineEdit() {
  const [expandedOrderIds, setExpandedOrderIds] = useState<string[]>([]);
  const [ledgerOrderDetails, setLedgerOrderDetails] = useState<Record<number, AccountExecutionDetail>>({});
  const [ledgerOrderDetailLoading, setLedgerOrderDetailLoading] = useState<Record<number, boolean>>({});
  const loadLedgerDetail = async (order: Pick<Order, "id" | "account_id">, force = false) => {
    if (order.account_id == null) return;
    try {
      await loadLedgerOrderDetail(order.id, force);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };
  const loadLedgerOrderDetail = async (orderId: number, force = false) => {
    if (!force && (ledgerOrderDetails[orderId] || ledgerOrderDetailLoading[orderId])) return;
    setLedgerOrderDetailLoading((current) => ({ ...current, [orderId]: true }));
    try {
      const detail = await ordersApi.executionDetail(orderId);
      setLedgerOrderDetails((current) => ({ ...current, [orderId]: detail }));
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setLedgerOrderDetailLoading((current) => ({ ...current, [orderId]: false }));
    }
  };
  const orderDetailEditor = useOrderDetailEditor({
    getExecutionDetail: (id) => Object.values(ledgerOrderDetails).find((detail) => detail.account.id === id),
    onSaved: (id, detail) => {
      setLedgerOrderDetails((current) => Object.fromEntries(
        Object.entries(current).map(([orderId, cached]) => cached.account.id === id ? [orderId, detail] : [orderId, cached]),
      ));
    },
  });

  const openLedgerEditor = async (order: Order) => {
    try {
      let accountId = order.account_id;
      if (accountId == null) {
        appMessage.warning("该订单未关联库存账号，无法编辑账号资料");
        return;
      }
      const detail = ledgerOrderDetails[order.id]
        ?? await ordersApi.executionDetail(order.id);
      setLedgerOrderDetails((current) => ({ ...current, [order.id]: detail }));
      setExpandedOrderIds([String(order.id)]);
      await orderDetailEditor.openEditor(detail.account);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const ledgerDetails = useMemo(
    () => Object.fromEntries(Object.values(ledgerOrderDetails).map((detail) => [detail.account.id, detail])),
    [ledgerOrderDetails],
  );

  const handleLedgerExpand = (expanded: boolean, record: Order) => {
    // 手风琴：一次只展开一行，避免多行展开同时挂载多份详情导致 DOM 与页面长度翻倍。
    setExpandedOrderIds(expanded ? [String(record.id)] : []);
    if (expanded) void loadLedgerOrderDetail(record.id);
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
    cancelInlineEdit: orderDetailEditor.cancelInlineEdit,
    editingAccount: orderDetailEditor.editingAccount,
    employees: orderDetailEditor.employees,
    eventDrafts: orderDetailEditor.eventDrafts,
    financeDrafts: orderDetailEditor.financeDrafts,
    inlineEditId: orderDetailEditor.inlineEditId,
    invEditExtraForm: orderDetailEditor.invEditExtraForm,
    saveInline: orderDetailEditor.saveInline,
    savingAccount: orderDetailEditor.savingAccount,
    updateEventDraft: orderDetailEditor.updateEventDraft,
    updateFinanceDraft: orderDetailEditor.updateFinanceDraft,
    updateEditingAccount: orderDetailEditor.updateEditingAccount,
    orderDrafts: orderDetailEditor.orderDrafts,
    updateOrderDraft: orderDetailEditor.updateOrderDraft,
    partyDrafts: orderDetailEditor.partyDrafts,
    updatePartyDraft: orderDetailEditor.updatePartyDraft,
  };
}
