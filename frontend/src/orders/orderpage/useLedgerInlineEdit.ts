import { useState } from "react";
import { ordersApi } from "../../shared/api/orders.api";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Order } from "../../shared/api/types/orders";
import { normalizeError } from "../../shared/api/client";
import { appMessage } from "../../shared/ui/appFeedback";
import { useAccountExecutionEditor } from "../OrderDetailView/editing/use-account-execution-editor";

/**
 * 台账表格的展开详情缓存与账号内联编辑枢纽。
 * 订单与库存必须已有明确绑定，编辑器不负责补建库存档案。
 */
export function useLedgerInlineEdit() {
  const [expandedOrderIds, setExpandedOrderIds] = useState<string[]>([]);
  const [ledgerDetails, setLedgerDetails] = useState<Record<number, AccountExecutionDetail>>({});
  const [ledgerDetailLoading, setLedgerDetailLoading] = useState<Record<number, boolean>>({});
  const [ledgerOrderDetails, setLedgerOrderDetails] = useState<Record<number, AccountExecutionDetail>>({});
  const [ledgerOrderDetailLoading, setLedgerOrderDetailLoading] = useState<Record<number, boolean>>({});
  const loadLedgerDetail = async (order: Pick<Order, "id" | "account_id">, force = false) => {
    const accountId = order.account_id;
    if (accountId == null) return;
    if (!force && (ledgerDetails[accountId] || ledgerDetailLoading[accountId])) return;
    setLedgerDetailLoading((current) => ({ ...current, [accountId]: true }));
    try {
      const detail = await ordersApi.executionDetail(order.id);
      setLedgerDetails((current) => ({ ...current, [accountId]: detail }));
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setLedgerDetailLoading((current) => ({ ...current, [accountId]: false }));
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
  const accountEditor = useAccountExecutionEditor({
    getExecutionDetail: (id) => ledgerDetails[id],
    onSaved: (id, detail) => setLedgerDetails((current) => ({ ...current, [id]: detail })),
  });

  const openLedgerEditor = async (order: Order) => {
    try {
      let accountId = order.account_id;
      if (accountId == null) {
        appMessage.warning("该订单未关联库存账号，无法编辑账号资料");
        return;
      }
      const detail = ledgerDetails[accountId]
        ?? ledgerOrderDetails[order.id]
        ?? await ordersApi.executionDetail(order.id);
      setLedgerDetails((current) => ({ ...current, [accountId]: detail }));
      setLedgerOrderDetails((current) => ({ ...current, [order.id]: detail }));
      setExpandedOrderIds([String(order.id)]);
      await accountEditor.openEditor(detail.account);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const handleLedgerExpand = (expanded: boolean, record: Order) => {
    // 手风琴：一次只展开一行，避免多行展开同时挂载多份详情导致 DOM 与页面长度翻倍。
    setExpandedOrderIds(expanded ? [String(record.id)] : []);
    if (expanded) void loadLedgerOrderDetail(record.id);
  };

  // accountEditor 还持有 openEditor（仅本 hook 内部使用），对外只暴露原契约中的 12 个键。
  return {
    expandedOrderIds,
    setExpandedOrderIds,
    ledgerDetails,
    ledgerDetailLoading,
    loadLedgerDetail,
    ledgerOrderDetails,
    ledgerOrderDetailLoading,
    loadLedgerOrderDetail,
    openLedgerEditor,
    handleLedgerExpand,
    cancelInlineEdit: accountEditor.cancelInlineEdit,
    editingAccount: accountEditor.editingAccount,
    employees: accountEditor.employees,
    eventDrafts: accountEditor.eventDrafts,
    financeDrafts: accountEditor.financeDrafts,
    inlineEditId: accountEditor.inlineEditId,
    invEditExtraForm: accountEditor.invEditExtraForm,
    saveInline: accountEditor.saveInline,
    savingAccount: accountEditor.savingAccount,
    updateEventDraft: accountEditor.updateEventDraft,
    updateFinanceDraft: accountEditor.updateFinanceDraft,
    updateEditingAccount: accountEditor.updateEditingAccount,
    orderDrafts: accountEditor.orderDrafts,
    updateOrderDraft: accountEditor.updateOrderDraft,
    partyDrafts: accountEditor.partyDrafts,
    updatePartyDraft: accountEditor.updatePartyDraft,
  };
}
