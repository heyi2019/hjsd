import { Form } from "antd";
import { useRef, useState } from "react";
import { employeesApi } from "../../../shared/api/org.api";
import { ordersApi } from "../../../shared/api/orders.api";
import { useSession } from "../../../shared/state/session";
import type { AccountExecutionDetail, AccountExecutionEvent } from "../../../shared/api/types/account-execution";
import type { Account } from "../../../shared/api/types/accounts";
import type { EmployeeOption } from "../../../shared/api/types/org";
import type { Pool } from "../../../shared/api/types/finance";
import { poolsApi } from "../../../shared/api/pools.api";
import { normalizeError } from "../../../shared/api/client";
import { appMessage } from "../../../shared/ui/appFeedback";
import { buildEventEdits, buildOperationEventCreates } from "./execution-edit-payload";
import type { EventDraft, OperationDraft, FinanceDraft, OrderDraft, PartyAddition, OrderDetailEditor } from "./editor-types";
import { defaultOperatorUserIds, propagateSharedOrderExtra, sharedOrderIdsForEdit } from "./editor-utils";

/**
 * 订单详情编辑器状态机：库存中心和订单台账共用同一份订单级编辑状态。
 * 账号资料随强绑定订单一起保存，读取与保存后的回读始终限定为当前订单。
 *
 * 详情缓存由各调用方注入（getExecutionDetail / onSaved），hook 自身不持有列表缓存，
 * 库存中心与订单台账因此可共用同一套编辑状态，同时保留各自的列表筛选口径。
 */
export function useOrderDetailEditor(params: {
  getExecutionDetail: (accountId: number) => AccountExecutionDetail | undefined;
  onSaved: (accountId: number, detail: AccountExecutionDetail) => void;
}): OrderDetailEditor {
  const { getExecutionDetail, onSaved } = params;
  const { username } = useSession();
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [inlineEditId, setInlineEditId] = useState<number | null>(null);
  const [eventDrafts, setEventDrafts] = useState<Record<number, EventDraft>>({});
  const [operationDrafts, setOperationDrafts] = useState<Record<string, OperationDraft>>({});
  const operationDraftSequence = useRef(0);
  const [financeDrafts, setFinanceDrafts] = useState<Record<string, FinanceDraft>>({});
  const [orderDrafts, setOrderDrafts] = useState<Record<number, OrderDraft>>({});
  const [partyDrafts, setPartyDrafts] = useState<Record<number, PartyAddition[]>>({});
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [invEditExtraForm] = Form.useForm();
  const [savingAccount, setSavingAccount] = useState(false);

  async function ensureEmployees(): Promise<EmployeeOption[]> {
    if (employees.length) return employees;
    try {
      const list = await employeesApi.list();
      setEmployees(list);
      return list;
    } catch {
      setEmployees([]);
      // 员工列表加载失败不阻断编辑：事件操作人下拉可在保存前重试或留空由后端校验。
      return [];
    }
  }

  async function ensurePools(): Promise<Pool[]> {
    if (pools.length) return pools;
    try {
      const list = await poolsApi.list();
      const visiblePools = Array.isArray(list) ? list : [];
      setPools(visiblePools);
      return visiblePools;
    } catch {
      setPools([]);
      return [];
    }
  }

  async function openEditor(account: Account) {
    setEditingAccount({ ...account });
    setEventDrafts({});
    setOperationDrafts({});
    setFinanceDrafts({});
    setOrderDrafts({});
    setPartyDrafts({});
    await Promise.all([ensureEmployees(), ensurePools()]);
    setInlineEditId(account.id);
  }

  function cancelInlineEdit() {
    setInlineEditId(null);
    setEditingAccount(null);
    setEventDrafts({});
    setOperationDrafts({});
    setFinanceDrafts({});
    setOrderDrafts({});
    setPartyDrafts({});
    invEditExtraForm.resetFields();
  }

  function updateEventDraft(event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }) {
    setEventDrafts((current) => ({
      ...current,
      [event.id]: {
        ...(current[event.id] ?? { id: event.id, expected_amount: event.amount, amount: event.amount, note: event.note ?? null, occurred_at: event.occurred_at ?? "", form_extra: event.form_extra ?? {} }),
        ...changes,
      },
    }));
  }

  function updateOperationDraft(key: string, changes: Partial<OperationDraft>) {
    setOperationDrafts((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? { occurred_at: "", form_extra: {} }),
        ...changes,
      },
    }));
  }

  function addOperationDraft(operationType: NonNullable<OperationDraft["operation_type"]>) {
    operationDraftSequence.current += 1;
    const key = `new:${operationType.toLowerCase()}:${operationDraftSequence.current}`;
    setOperationDrafts((current) => ({
      ...current,
      [key]: {
        occurred_at: "",
        form_extra: {},
        operation_type: operationType,
        operator_user_ids: defaultOperatorUserIds(employees, username),
      },
    }));
  }

  function removeOperationDraft(key: string) {
    setOperationDrafts((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function updateFinanceDraft(flowNo: string, changes: Partial<Omit<FinanceDraft, "flow_no">>) {
    setFinanceDrafts((current) => ({
      ...current,
      [flowNo]: { ...(current[flowNo] ?? { flow_no: flowNo, occurred_at: "", note: "" }), ...changes },
    }));
  }

  function updateEditingAccount(changes: Partial<Account>) {
    setEditingAccount((current) => current ? { ...current, ...changes } : current);
  }

  function updateOrderDraft(orderId: number, changes: Partial<Omit<OrderDraft, "order_id">>) {
    const detail = editingAccount ? getExecutionDetail(editingAccount.id) : undefined;
    const sharedOrderIds = sharedOrderIdsForEdit(detail, orderId);
    setOrderDrafts((current) => {
      const currentDraft = current[orderId] ?? { order_id: orderId, occurred_at: "", note: "", form_extra: {} };
      const next = {
        ...current,
        [orderId]: {
          ...currentDraft,
          ...changes,
          form_extra: { ...currentDraft.form_extra, ...(changes.form_extra ?? {}) },
        },
      };
      const sharedExtra = changes.form_extra ?? {};
      return propagateSharedOrderExtra(next, sharedOrderIds, sharedExtra);
    });
  }

  function updatePartyDraft(orderId: number, addition: PartyAddition) {
    setPartyDrafts((current) => {
      const existing = current[orderId] ?? [];
      const same = (item: PartyAddition) => item.entity_type === addition.entity_type
        && item.entity_id === addition.entity_id
        && item.role === addition.role;
      if (existing.some((item) => same(item) && (item.operation ?? "add") === (addition.operation ?? "add"))) return current;
      return { ...current, [orderId]: [...existing.filter((item) => !same(item)), addition] };
    });
  }

  async function saveInline() {
    if (!editingAccount) return;
    setSavingAccount(true);
    try {
      const {
        id,
        game_account,
        game_type,
        game_password,
        camp_account,
        channel_region,
        bound_phone,
        has_secondary,
        secondary_images,
        wallet_realname,
        wallet_realname_images,
        account_description,
        account_images,
        note,
        extra_values,
      } = editingAccount;
      const profile = {
        game_account,
        game_type,
        game_password,
        camp_account,
        channel_region,
        bound_phone,
        has_secondary,
        secondary_images,
        wallet_realname,
        wallet_realname_images,
        account_description,
        account_images,
        note,
        extra_values,
        form_extra: invEditExtraForm.getFieldsValue()?.form_extra,
      };
      const detail = getExecutionDetail(id);
      const originalEvents = detail?.orders.flatMap((order) => order.events) ?? [];
      const events = buildEventEdits(originalEvents, eventDrafts);
      const new_events = buildOperationEventCreates(operationDrafts);
      const originalFinanceRows = detail?.detail_view.finance_rows ?? [];
      const cashflows = Object.values(financeDrafts).filter((draft) => {
        const original = originalFinanceRows.find((row) => row.flow_no === draft.flow_no);
        return original && (
          draft.amount !== undefined && draft.amount !== original.amount
          || draft.pool_id !== undefined && draft.pool_id !== original.pool_id
          || draft.occurred_at !== (original.occurred_at ?? "")
          || draft.note !== (original.note ?? "")
          || draft.operator_user_ids !== undefined
            && JSON.stringify(draft.operator_user_ids) !== JSON.stringify(original.operator_user_ids ?? [])
        );
      }).map((draft) => ({
        flow_no: draft.flow_no,
        ...(draft.amount !== undefined ? { amount: draft.amount } : {}),
        ...(draft.pool_id !== undefined ? { pool_id: draft.pool_id } : {}),
        ...(draft.occurred_at ? { occurred_at: draft.occurred_at } : {}),
        note: draft.note,
        ...(draft.operator_user_ids !== undefined ? { operator_user_ids: draft.operator_user_ids } : {}),
      }));
      const originalOrders = detail?.orders ?? [];
      const orders = Object.values(orderDrafts).filter((draft) => {
        const original = originalOrders.find((order) => order.order_id === draft.order_id);
        return Boolean(original && (
          draft.occurred_at !== (original.created_at ?? "")
          || draft.note !== (original.note ?? "")
          || Object.keys(draft.form_extra).length > 0
        ));
      }).map((draft) => ({
        order_id: draft.order_id,
        ...(draft.occurred_at ? { occurred_at: draft.occurred_at } : {}),
        note: draft.note,
        ...(Object.keys(draft.form_extra).length ? { form_extra: draft.form_extra } : {}),
      }));
      const parties = Object.entries(partyDrafts).flatMap(([orderId, additions]) => additions.map((item) => ({ order_id: Number(orderId), ...item })));
      const sourceOrderId = editingAccount.source_order_id;
      if (sourceOrderId == null) throw new Error("账号没有绑定来源订单，无法保存详情");
      await ordersApi.updateExecution(sourceOrderId, {
        profile,
        events,
        new_events,
        cashflows,
        orders,
        parties,
      });
      try {
        const detail = await ordersApi.executionDetail(sourceOrderId);
        onSaved(id, detail);
      } catch (refreshError) {
        appMessage.warning("修改已保存，但刷新明细失败，请重新加载");
        console.warn("reload execution detail after save failed", normalizeError(refreshError).message);
        throw refreshError;
      }
      setEditingAccount(null);
      setEventDrafts({});
      setOperationDrafts({});
      setFinanceDrafts({});
      setOrderDrafts({});
      setPartyDrafts({});
      invEditExtraForm.resetFields();
      setInlineEditId(null);
      appMessage.success("修改已保存");
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setSavingAccount(false);
    }
  }

  return {
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
    ensureEmployees,
    invEditExtraForm,
    savingAccount,
    openEditor,
    cancelInlineEdit,
    saveInline,
  };
}

/** 类型与纯函数出口：保持拆分前 use-order-detail-editor 的全部导出符号不变。 */
export type { EventDraft, OperationDraft, FinanceDraft, OrderDraft, PartyAddition, OrderDetailEditor } from "./editor-types";
export { defaultOperatorUserIds, propagateSharedOrderExtra, sharedOrderIdsForEdit } from "./editor-utils";
