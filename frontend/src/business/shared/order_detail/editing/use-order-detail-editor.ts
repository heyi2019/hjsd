import { Form } from "antd";
import { useRef, useState } from "react";
import { ordersApi } from "../../../../shared/api/orders.api";
import { useSession } from "../../../../shared/state/session";
import type { AccountExecutionDetail, AccountExecutionEvent } from "../../../../shared/api/types/account-execution";
import type { Account } from "../../../../shared/api/types/accounts";
import type { EmployeeOption } from "../../../../shared/api/types/org";
import type { Pool } from "../../../../shared/api/types/finance";
import { poolsApi } from "../../../../shared/api/pools.api";
import { normalizeError } from "../../../../shared/api/client";
import { appMessage } from "../../../../shared/ui/appFeedback";
import { useLatestRequest } from "../../../../shared/hooks/useLatestRequest";
import { useAsyncAction } from "../../../../shared/hooks/useAsyncAction";
import { useEmployeeOptions } from "../../../../shared/hooks/useEmployeeOptions";
import { useReferenceList } from "../../../../shared/hooks/useReferenceList";
import { buildEventEdits, buildFinanceEdits, buildOperationEventCreates, buildOrderEdits } from "./execution-edit-payload";
import type { EventDraft, OperationDraft, FinanceDraft, OrderDraft, PartyAddition, OrderDetailEditor } from "./editor-types";
import { defaultOperatorUserIds, propagateSharedOrderExtra, sharedOrderIdsForEdit } from "./editor-utils";
import { editedMoneyError } from "./amount-validation";

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
  onRefreshFailed: (accountId: number, orderId: number) => void;
}): OrderDetailEditor {
  const { getExecutionDetail, onSaved, onRefreshFailed } = params;
  const { username } = useSession();
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [inlineEditId, setInlineEditId] = useState<number | null>(null);
  const [eventDrafts, setEventDrafts] = useState<Record<number, EventDraft>>({});
  const [operationDrafts, setOperationDrafts] = useState<Record<string, OperationDraft>>({});
  const operationDraftSequence = useRef(0);
  const [financeDrafts, setFinanceDrafts] = useState<Record<string, FinanceDraft>>({});
  const [orderDrafts, setOrderDrafts] = useState<Record<number, OrderDraft>>({});
  const [partyDrafts, setPartyDrafts] = useState<Record<number, PartyAddition[]>>({});
  const { employees, error: employeeError, reload: reloadEmployees, reloadFresh: reloadFreshEmployees } = useEmployeeOptions(false);
  const { items: pools, error: poolError, reload: reloadPools } = useReferenceList("pools", poolsApi.list, false);
  const [invEditExtraForm] = Form.useForm();
  const originalAccount = useRef<Account | null>(null);
  const originalDetail = useRef<AccountExecutionDetail | null>(null);
  const originalAccountExtras = useRef<Record<string, unknown>>({});
  const saveAction = useAsyncAction();
  const savingAccount = saveAction.pending;
  const openVersion = useLatestRequest();
  const openingEditor = useRef(false);

  function getOriginalDetail(accountId: number): AccountExecutionDetail | undefined {
    if (!originalDetail.current) {
      const detail = getExecutionDetail(accountId);
      if (detail) originalDetail.current = JSON.parse(JSON.stringify(detail)) as AccountExecutionDetail;
    }
    return originalDetail.current ?? undefined;
  }

  async function ensureEmployees(fresh = false): Promise<EmployeeOption[]> {
    if (employees.length) {
      if (fresh) void reloadFreshEmployees().catch(() => undefined);
      return employees;
    }
    try {
      return await (fresh ? reloadFreshEmployees() : reloadEmployees());
    } catch {
      // 员工列表加载失败不阻断编辑：事件操作人下拉可在保存前重试或留空由后端校验。
      return [];
    }
  }

  async function ensurePools(): Promise<Pool[]> {
    if (pools.length) return pools;
    try {
      return await reloadPools();
    } catch {
      return [];
    }
  }

  function clearEditor() {
    setInlineEditId(null);
    setEditingAccount(null);
    setEventDrafts({});
    setOperationDrafts({});
    setFinanceDrafts({});
    setOrderDrafts({});
    setPartyDrafts({});
    originalAccount.current = null;
    originalDetail.current = null;
    originalAccountExtras.current = {};
    invEditExtraForm.resetFields();
  }

  async function openEditor(account: Account, isCurrent?: () => boolean): Promise<boolean> {
    if (saveAction.isPending()) {
      appMessage.warning("当前订单正在保存，请稍候");
      return false;
    }
    const version = openVersion.start();
    openingEditor.current = true;
    setInlineEditId(null);
    setEditingAccount({ ...account });
    setEventDrafts({});
    setOperationDrafts({});
    setFinanceDrafts({});
    setOrderDrafts({});
    setPartyDrafts({});
    invEditExtraForm.resetFields();
    originalAccount.current = JSON.parse(JSON.stringify(account)) as Account;
    const detail = getExecutionDetail(account.id);
    originalDetail.current = detail ? JSON.parse(JSON.stringify(detail)) as AccountExecutionDetail : null;
    originalAccountExtras.current = { ...(account.extra_values ?? {}) };
    invEditExtraForm.setFieldsValue({ form_extra: account.extra_values ?? {} });
    await Promise.all([ensureEmployees(true), ensurePools()]);
    if (!openVersion.isCurrent(version)) return false;
    if (isCurrent && !isCurrent()) {
      openingEditor.current = false;
      clearEditor();
      return false;
    }
    openingEditor.current = false;
    setInlineEditId(account.id);
    return true;
  }

  function cancelPendingOpen() {
    openVersion.invalidate();
    if (openingEditor.current) {
      openingEditor.current = false;
      clearEditor();
    }
  }

  function cancelInlineEdit() {
    if (saveAction.isPending()) {
      appMessage.warning("当前订单正在保存，请稍候");
      return;
    }
    openingEditor.current = false;
    openVersion.invalidate();
    clearEditor();
  }

  function updateEventDraft(event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }) {
    if (saveAction.isPending()) return;
    if (editingAccount) getOriginalDetail(editingAccount.id);
    setEventDrafts((current) => ({
      ...current,
      [event.id]: {
        ...(current[event.id] ?? { id: event.id, expected_amount: event.amount, amount: event.amount, note: event.note ?? null, occurred_at: event.occurred_at ?? "", form_extra: event.form_extra ?? {} }),
        ...changes,
      },
    }));
  }

  function updateOperationDraft(key: string, changes: Partial<OperationDraft>) {
    if (saveAction.isPending()) return;
    setOperationDrafts((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? { occurred_at: "", form_extra: {} }),
        ...changes,
      },
    }));
  }

  function addOperationDraft(operationType: NonNullable<OperationDraft["operation_type"]>) {
    if (saveAction.isPending()) return;
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
    if (saveAction.isPending()) return;
    setOperationDrafts((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function updateFinanceDraft(flowNo: string, changes: Partial<Omit<FinanceDraft, "flow_no">>) {
    if (saveAction.isPending()) return;
    if (editingAccount) getOriginalDetail(editingAccount.id);
    setFinanceDrafts((current) => ({
      ...current,
      [flowNo]: { ...(current[flowNo] ?? { flow_no: flowNo, occurred_at: "", note: "" }), ...changes },
    }));
  }

  function updateEditingAccount(changes: Partial<Account>) {
    if (saveAction.isPending()) return;
    setEditingAccount((current) => current ? { ...current, ...changes } : current);
  }

  function updateOrderDraft(orderId: number, changes: Partial<Omit<OrderDraft, "order_id">>) {
    if (saveAction.isPending()) return;
    const detail = editingAccount ? getOriginalDetail(editingAccount.id) : undefined;
    const sharedOrderIds = sharedOrderIdsForEdit(detail, orderId);
    const originalOrders = detail?.orders ?? [];
    const originalOrder = originalOrders.find((order) => order.order_id === orderId);
    setOrderDrafts((current) => {
      const currentDraft = current[orderId] ?? { order_id: orderId, occurred_at: originalOrder?.occurred_at ?? originalOrder?.created_at ?? "", note: originalOrder?.note ?? "", form_extra: {} };
      const next = {
        ...current,
        [orderId]: {
          ...currentDraft,
          ...changes,
          form_extra: { ...currentDraft.form_extra, ...(changes.form_extra ?? {}) },
        },
      };
      const sharedExtra = changes.form_extra ?? {};
      return propagateSharedOrderExtra(next, sharedOrderIds, sharedExtra, originalOrders);
    });
  }

  function updatePartyDraft(orderId: number, addition: PartyAddition) {
    if (saveAction.isPending()) return;
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
    await saveAction.run(async () => {
      try {
        const extraValues = await invEditExtraForm.validateFields();
        const { id, extra_values } = editingAccount;
        const original = originalAccount.current;
        if (!original) throw new Error("编辑资料已失效，请重新打开");
        const fields = ["game_account", "game_type", "game_password", "camp_account", "channel_region", "bound_phone", "has_secondary", "secondary_images", "wallet_realname", "wallet_realname_images", "account_description", "account_images", "note"] as const;
        const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
        const changedFields = fields.filter((field) => !same(editingAccount[field], original[field]));
        const changedAccountKeys = [...new Set([...Object.keys(originalAccountExtras.current), ...Object.keys(extra_values ?? {})])]
          .filter((key) => !same(extra_values?.[key], originalAccountExtras.current[key]));
        const changedFormKeys = Object.keys(extraValues?.form_extra ?? {})
          .filter((key) => !same(extraValues.form_extra[key], originalAccountExtras.current[key]));
        const changedAccountExtras = Object.fromEntries(changedAccountKeys.map((key) => [key, extra_values?.[key] ?? null]));
        const profile = {
          ...Object.fromEntries(changedFields.map((field) => [field, editingAccount[field] ?? null])),
          ...(changedAccountKeys.length ? { extra_values: changedAccountExtras } : {}),
          form_extra: Object.fromEntries(changedFormKeys.map((key) => [key, extraValues.form_extra[key] ?? null])),
        };
        const expectedProfile = {
          ...Object.fromEntries(changedFields.map((field) => [field, original[field] ?? null])),
          ...(changedAccountKeys.length ? { extra_values: Object.fromEntries(changedAccountKeys.map((key) => [key, originalAccountExtras.current[key] ?? null])) } : {}),
          form_extra: Object.fromEntries(changedFormKeys.map((key) => [key, originalAccountExtras.current[key] ?? null])),
        };
        const detail = getOriginalDetail(id);
        const originalEvents = detail?.orders.flatMap((order) => order.events) ?? [];
        const events = buildEventEdits(originalEvents, eventDrafts);
        if (events.some((item) => editedMoneyError(item.amount))) { appMessage.error("请填写有效的金额"); return; }
        const new_events = buildOperationEventCreates(operationDrafts);
        const cashflows = buildFinanceEdits(detail?.detail_view.finance_rows ?? [], financeDrafts);
        if (cashflows.some((item) => item.amount !== undefined && editedMoneyError(item.amount))) { appMessage.error("请填写有效的金额"); return; }
        const orders = buildOrderEdits(detail?.orders ?? [], orderDrafts);
        const parties = Object.entries(partyDrafts).flatMap(([orderId, additions]) => additions.map((item) => ({ order_id: Number(orderId), ...item })));
        const sourceOrderId = editingAccount.source_order_id;
        if (sourceOrderId == null) throw new Error("账号没有绑定来源订单，无法保存详情");
        await ordersApi.updateExecution(sourceOrderId, {
          profile,
          expected_profile: expectedProfile,
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
          clearEditor();
          onRefreshFailed(id, sourceOrderId);
          appMessage.warning("修改已保存，但刷新明细失败，请重新加载");
          console.warn("reload execution detail after save failed", normalizeError(refreshError).message);
          return;
        }
        clearEditor();
        appMessage.success("修改已保存");
      } catch (err) {
        appMessage.error(normalizeError(err).message);
      }
    });
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
    employeeError,
    poolError,
    retryEmployees: reloadFreshEmployees,
    retryPools: () => reloadPools(() => poolsApi.list({ fresh: true })),
    ensureEmployees,
    invEditExtraForm,
    savingAccount,
    openEditor,
    cancelPendingOpen,
    isSaving: saveAction.isPending,
    cancelInlineEdit,
    saveInline,
  };
}
