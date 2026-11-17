import { Form } from "antd";
import { useRef, useState } from "react";
import { employeesApi } from "../../../shared/api/org.api";
import { ordersApi } from "../../../shared/api/orders.api";
import { useSession } from "../../../shared/state/session";
import type { AccountExecutionDetail, AccountExecutionEvent } from "../../../shared/api/types/account-execution";
import type { Account } from "../../../shared/api/types/accounts";
import type { EmployeeOption } from "../../../shared/api/types/org";
import { normalizeError } from "../../../shared/api/client";
import { appMessage } from "../../../shared/ui/appFeedback";
import { buildEventEdits, buildOperationEventCreates, type ExecutionEventDraft } from "./execution-edit-payload";
import type { OrderOperationDraft } from "../OrderDetail.shared";

export type EventDraft = ExecutionEventDraft;
export type OperationDraft = OrderOperationDraft;
export type FinanceDraft = {
  flow_no: string;
  occurred_at: string;
  note: string;
  operator_user_ids?: number[];
};
export type OrderDraft = {
  order_id: number;
  occurred_at: string;
  note: string;
  form_extra: Record<string, unknown>;
};

const SHARED_ORDER_FORM_EXTRA_KEYS = new Set(["bound_phone_owner"]);

/** 新增详情动作行沿用建单口径：默认当前会话对应的在职员工。 */
export function defaultOperatorUserIds(employees: EmployeeOption[], username: string): number[] | undefined {
  const employee = employees.find((item) => item.is_active && item.username === username);
  return employee ? [employee.id] : undefined;
}

/** 把订单详情内的共享交付字段投影到当前详情涉及的全部订单草稿。 */
export function propagateSharedOrderExtra(
  drafts: Record<number, OrderDraft>,
  orderIds: number[],
  changes: Record<string, unknown>,
): Record<number, OrderDraft> {
  const sharedChanges = Object.fromEntries(
    Object.entries(changes).filter(([key]) => SHARED_ORDER_FORM_EXTRA_KEYS.has(key)),
  );
  if (!Object.keys(sharedChanges).length) return drafts;

  const next = { ...drafts };
  orderIds.forEach((orderId) => {
    const current = next[orderId] ?? {
      order_id: orderId,
      occurred_at: "",
      note: "",
      form_extra: {},
    };
    next[orderId] = {
      ...current,
      form_extra: { ...current.form_extra, ...sharedChanges },
    };
  });
  return next;
}

/** 解析共享字段需要同步的订单，避免在 React 状态更新回调里读取详情缓存。 */
export function sharedOrderIdsForEdit(
  detail: Pick<AccountExecutionDetail, "orders"> | undefined,
  fallbackOrderId: number,
): number[] {
  return detail?.orders.map((order) => order.order_id) ?? [fallbackOrderId];
}

export type PartyAddition = {
  entity_type: "customer" | "counterparty";
  entity_id: number;
  role: string;
  operation?: "add" | "remove";
};

export interface OrderDetailEditor {
  editingAccount: Account | null;
  inlineEditId: number | null;
  eventDrafts: Record<number, EventDraft>;
  updateEventDraft: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }) => void;
  operationDrafts: Partial<Record<string, OperationDraft>>;
  updateOperationDraft: (key: string, changes: Partial<OperationDraft>) => void;
  addOperationDraft: (operationType: NonNullable<OperationDraft["operation_type"]>) => void;
  removeOperationDraft: (key: string) => void;
  financeDrafts: Record<string, FinanceDraft>;
  updateFinanceDraft: (flowNo: string, changes: Partial<Omit<FinanceDraft, "flow_no">>) => void;
  updateEditingAccount: (changes: Partial<Account>) => void;
  orderDrafts: Record<number, OrderDraft>;
  updateOrderDraft: (orderId: number, changes: Partial<Omit<OrderDraft, "order_id">>) => void;
  partyDrafts: Record<number, PartyAddition[]>;
  updatePartyDraft: (orderId: number, addition: PartyAddition) => void;
  employees: EmployeeOption[];
  ensureEmployees: () => Promise<EmployeeOption[]>;
  invEditExtraForm: ReturnType<typeof Form.useForm>[0];
  savingAccount: boolean;
  openEditor: (account: Account) => Promise<void>;
  cancelInlineEdit: () => void;
  saveInline: () => Promise<void>;
}

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

  async function openEditor(account: Account) {
    setEditingAccount({ ...account });
    setEventDrafts({});
    setOperationDrafts({});
    setFinanceDrafts({});
    setOrderDrafts({});
    setPartyDrafts({});
    await ensureEmployees();
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
        platform,
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
        platform,
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
          draft.occurred_at !== (original.occurred_at ?? "")
          || draft.note !== (original.note ?? "")
          || draft.operator_user_ids !== undefined
            && JSON.stringify(draft.operator_user_ids) !== JSON.stringify(original.operator_user_ids ?? [])
        );
      }).map((draft) => ({
        flow_no: draft.flow_no,
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
    ensureEmployees,
    invEditExtraForm,
    savingAccount,
    openEditor,
    cancelInlineEdit,
    saveInline,
  };
}
