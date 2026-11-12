import { useState, type Dispatch, type SetStateAction } from "react";
import { ordersApi } from "../../shared/api/orders.api";
import { stocksApi } from "../../shared/api/stocks.api";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import type { Order } from "../../shared/api/types/orders";
import { normalizeError } from "../../shared/api/client";
import { appMessage } from "../../shared/ui/appFeedback";
import { useAccountExecutionEditor } from "../../stocks/InventoryPanel/useAccountExecutionEditor";

/**
 * 台账表格的展开详情缓存与账号内联编辑枢纽。
 * 逐字切片自 useOrdersPageController；setOrders 由列表域注入，避免与数据层循环依赖。
 */
export function useLedgerInlineEdit({ setOrders }: { setOrders: Dispatch<SetStateAction<Order[]>> }) {
  const [expandedOrderIds, setExpandedOrderIds] = useState<string[]>([]);
  const [ledgerDetails, setLedgerDetails] = useState<Record<number, AccountExecutionDetail>>({});
  const [ledgerDetailLoading, setLedgerDetailLoading] = useState<Record<number, boolean>>({});
  const loadLedgerDetail = async (accountId: number, force = false) => {
    if (!force && (ledgerDetails[accountId] || ledgerDetailLoading[accountId])) return;
    setLedgerDetailLoading((current) => ({ ...current, [accountId]: true }));
    try {
      const detail = await stocksApi.executionDetail(accountId);
      setLedgerDetails((current) => ({ ...current, [accountId]: detail }));
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setLedgerDetailLoading((current) => ({ ...current, [accountId]: false }));
    }
  };
  const accountEditor = useAccountExecutionEditor({
    getExecutionDetail: (id) => ledgerDetails[id],
    onSaved: (id, detail) => setLedgerDetails((current) => ({ ...current, [id]: detail })),
  });

  const openLedgerAccountEditor = async (account: Account) => {
    await accountEditor.openEditor(account);
  };

  const openLedgerEditor = async (order: Order) => {
    try {
      let accountId = order.account_id;
      if (accountId == null) {
        if (!['ACTIVE', 'INSTALLMENT'].includes(order.status)) {
          appMessage.warning("该历史订单未关联库存账号，当前状态不能补建库存");
          return;
        }
        const materialized = await ordersApi.materializeAccount(order.id);
        accountId = materialized.account_id;
        if (accountId == null) throw new Error("补建库存账号后未返回库存编号");
        setOrders((current) => current.map((item) => item.id === order.id ? { ...item, ...materialized } : item));
        appMessage.success("已补建库存账号");
      }
      const detail = ledgerDetails[accountId] ?? await stocksApi.executionDetail(accountId);
      setLedgerDetails((current) => ({ ...current, [accountId]: detail }));
      setExpandedOrderIds([String(order.id)]);
      await openLedgerAccountEditor(detail.account);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const handleLedgerExpand = (expanded: boolean, record: Order) => {
    // 手风琴：一次只展开一行，避免多行展开同时挂载多份详情导致 DOM 与页面长度翻倍。
    setExpandedOrderIds(expanded ? [String(record.id)] : []);
    if (expanded && record.account_id) void loadLedgerDetail(record.account_id);
  };

  // accountEditor 还持有 openEditor（仅本 hook 内部使用），对外只暴露原契约中的 12 个键。
  return {
    expandedOrderIds,
    setExpandedOrderIds,
    ledgerDetails,
    ledgerDetailLoading,
    loadLedgerDetail,
    openLedgerAccountEditor,
    openLedgerEditor,
    handleLedgerExpand,
    cancelInlineEdit: accountEditor.cancelInlineEdit,
    editingAccount: accountEditor.editingAccount,
    employees: accountEditor.employees,
    eventDrafts: accountEditor.eventDrafts,
    inlineEditId: accountEditor.inlineEditId,
    invEditExtraForm: accountEditor.invEditExtraForm,
    saveInline: accountEditor.saveInline,
    savingAccount: accountEditor.savingAccount,
    setEditingAccount: accountEditor.setEditingAccount,
    setTimeShiftDays: accountEditor.setTimeShiftDays,
    timeShiftMinutes: accountEditor.timeShiftMinutes,
    updateEventDraft: accountEditor.updateEventDraft,
  };
}
